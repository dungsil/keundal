import { compact, SummaryCompactionConfigSchema, type SummaryCompactionConfig } from '@keundal/compaction'
import {
  parseRunAgentInput,
  type AGUIEvent,
  type CompactionResult,
  type ExecutionOptions,
  type RunAgentInput
} from '@keundal/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Service, type Context } from 'cordis'

import { addTools, parseTools, streamWithTools, type ExecutableTool } from './tools.js'

export type { ExecutableTool, ToolExecutionContext } from './tools.js'

export interface SimpleAgentConfig {
  readonly model: string
  readonly maxOutputTokens: number
  readonly webSearch?: boolean
  readonly reasoning?: boolean
  readonly compaction?: SummaryCompactionConfig
  readonly tools?: readonly ExecutableTool[]
  /** 도구를 실행하고 후속 생성을 요청할 최대 횟수입니다. 기본값은 8입니다. */
  readonly maxToolRounds?: number
  /** 같은 응답의 도구 실행을 겹쳐 시작합니다. 기본값은 false로 순차 실행입니다. */
  readonly parallelTools?: boolean
}

const simpleAgentConfigSchema: StandardSchemaV1<SimpleAgentConfig, SimpleAgentConfig> = {
  '~standard': {
    version: 1,
    vendor: 'keundal',
    validate(value) {
      if (
        typeof value === 'object' &&
        value !== null &&
        'model' in value &&
        typeof value.model === 'string' &&
        value.model.trim().length > 0 &&
        'maxOutputTokens' in value &&
        typeof value.maxOutputTokens === 'number' &&
        Number.isSafeInteger(value.maxOutputTokens) &&
        value.maxOutputTokens > 0
      ) {
        const compaction = SummaryCompactionConfigSchema['~standard'].validate(
          'compaction' in value ? value.compaction : undefined
        )
        if (compaction.issues) return { issues: compaction.issues }
        try {
          for (const key of ['webSearch', 'reasoning'] as const) {
            const option = (value as Record<string, unknown>)[key]
            if (option !== undefined && typeof option !== 'boolean') {
              throw new Error(`${key} must be a boolean`)
            }
          }
          const tools = parseTools('tools' in value ? value.tools : undefined)
          const maxToolRounds = 'maxToolRounds' in value ? value.maxToolRounds : 8
          if (typeof maxToolRounds !== 'number' || !Number.isSafeInteger(maxToolRounds) || maxToolRounds <= 0) {
            throw new Error('maxToolRounds must be a positive integer')
          }
          const parallelTools = 'parallelTools' in value ? value.parallelTools : false
          if (typeof parallelTools !== 'boolean') throw new Error('parallelTools must be a boolean')
          return {
            value: {
              model: value.model,
              maxOutputTokens: value.maxOutputTokens,
              ...('webSearch' in value ? { webSearch: value.webSearch as boolean | undefined } : {}),
              ...('reasoning' in value ? { reasoning: value.reasoning as boolean | undefined } : {}),
              compaction: compaction.value,
              tools,
              maxToolRounds,
              parallelTools
            }
          }
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : 'invalid tools config' }] }
        }
      }
      return { issues: [{ message: 'model and a positive integer maxOutputTokens are required' }] }
    }
  }
}

declare module 'cordis' {
  interface Context {
    readonly agent: SimpleAgent
  }
}

export class SimpleAgent extends Service {
  private readonly active = new Set<AbortController>()
  private closed = false

  constructor(
    ctx: Context,
    private readonly config: SimpleAgentConfig
  ) {
    super(ctx, 'agent')
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const controller of this.active) controller.abort(new Error('simple agent disposed'))
    })
  }

  run(input: RunAgentInput, options: ExecutionOptions = {}): AsyncIterableIterator<AGUIEvent> {
    if (this.closed) throw new Error('simple agent disposed')
    const controller = new globalThis.AbortController()
    const externalSignal = options.signal
    const abort = () => controller.abort(externalSignal?.reason)
    const cleanup = () => {
      externalSignal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', cleanup)
      this.active.delete(controller)
    }
    this.active.add(controller)
    controller.signal.addEventListener('abort', cleanup, { once: true })
    if (externalSignal?.aborted) abort()
    else externalSignal?.addEventListener('abort', abort, { once: true })

    const stop = () => {
      if (!controller.signal.aborted) controller.abort(new Error('simple agent run stopped'))
      cleanup()
    }
    const iterator = this.execute(input, controller.signal, stop)
    return {
      next: () => iterator.next(),
      return: async () => {
        stop()
        return iterator.return(undefined)
      },
      throw: async (reason?: unknown) => {
        stop()
        return iterator.throw(reason)
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }

  private async *execute(
    input: RunAgentInput,
    signal: AbortSignal,
    cleanup: () => void
  ): AsyncGenerator<AGUIEvent, void, unknown> {
    try {
      signal.throwIfAborted()
      const request = parseRunAgentInput(input)
      const options = { signal }
      const prepared = await this.ctx.session.prepare(request, options)
      signal.throwIfAborted()
      const tools = this.config.tools ?? []
      const preparedInput = addTools(parseRunAgentInput(prepared.input), tools)
      if (preparedInput.threadId !== request.threadId || preparedInput.runId !== request.runId) {
        throw new Error('session preparation must preserve threadId and runId')
      }
      if (!Number.isSafeInteger(prepared.revision) || prepared.revision < 0) {
        throw new Error('session revision must be a non-negative integer')
      }

      const model = await this.ctx.llm.getModel(this.config.model, options)
      signal.throwIfAborted()
      const maxOutputTokens = this.config.maxOutputTokens
      if (
        !Number.isSafeInteger(model.contextWindow) ||
        !Number.isSafeInteger(model.maxOutputTokens) ||
        maxOutputTokens > model.maxOutputTokens ||
        maxOutputTokens >= model.contextWindow
      ) {
        throw new Error('requested output budget exceeds the model limits')
      }
      const maxInputTokens = model.contextWindow - maxOutputTokens
      const fitted = await this.fitInput(preparedInput, maxInputTokens, signal)

      signal.throwIfAborted()
      yield* this.ctx.generation.run(
        {
          input: fitted.input,
          model: this.config.model,
          maxOutputTokens,
          ...(this.config.webSearch === undefined ? {} : { webSearch: this.config.webSearch }),
          ...(this.config.reasoning === undefined ? {} : { reasoning: this.config.reasoning }),
          sessionRevision: prepared.revision,
          ...(fitted.compaction ? { compaction: fitted.compaction } : {})
        },
        {
          signal,
          ...(tools.length
            ? {
                stream: (request, execution) => {
                  const generationSignal = execution?.signal ?? signal
                  return streamWithTools(
                    this.ctx.llm,
                    request,
                    tools,
                    this.config.maxToolRounds ?? 8,
                    async (next) => (await this.fitInput(next, maxInputTokens, generationSignal)).input,
                    generationSignal,
                    { parallel: this.config.parallelTools ?? false }
                  )
                }
              }
            : {})
        }
      )
    } finally {
      cleanup()
    }
  }

  private async fitInput(
    input: RunAgentInput,
    maxInputTokens: number,
    signal: AbortSignal
  ): Promise<{ input: RunAgentInput; compaction?: CompactionResult }> {
    signal.throwIfAborted()
    const countTokens = async (candidate: RunAgentInput) => {
      const count = await this.ctx.llm.countTokens(
        {
          input: candidate,
          model: this.config.model,
          maxOutputTokens: this.config.maxOutputTokens,
          ...(this.config.webSearch === undefined ? {} : { webSearch: this.config.webSearch }),
          ...(this.config.reasoning === undefined ? {} : { reasoning: this.config.reasoning })
        },
        { signal }
      )
      signal.throwIfAborted()
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid input token count')
      return count
    }

    const count = await countTokens(input)
    if (count <= maxInputTokens) return { input }

    const compaction = await compact(
      this.ctx.llm,
      {
        input,
        model: this.config.model,
        maxInputTokens
      },
      { ...this.config.compaction, signal, inputTokens: count }
    )
    signal.throwIfAborted()
    const compacted = { ...input, messages: compaction.messages }
    // 축약기의 기본 계산과 달리 네이티브 검색 도구의 입력 비용까지 포함해 다시 검사합니다.
    if (
      (this.config.webSearch !== undefined || this.config.reasoning !== undefined) &&
      (await countTokens(compacted)) > maxInputTokens
    )
      throw new Error('compacted input exceeds the model input budget')
    return { input: compacted, compaction }
  }
}

export const simpleAgentPlugin = Object.assign(
  function simpleAgentPlugin(ctx: Context, config: SimpleAgentConfig) {
    new SimpleAgent(ctx, config)
  },
  { inject: ['llm', 'generation', 'session'], Config: simpleAgentConfigSchema }
)

export { simpleAgentConfigSchema as SimpleAgentConfigSchema }
export default simpleAgentPlugin
