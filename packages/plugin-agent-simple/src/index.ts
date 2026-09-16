import {
  parseRunAgentInput,
  type AGUIEvent,
  type CompactionResult,
  type ExecutionOptions,
  type RunAgentInput
} from '@keundal/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Service, type Context } from 'cordis'

export interface SimpleAgentConfig {
  readonly model: string
  readonly maxOutputTokens: number
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
        return { value: { model: value.model, maxOutputTokens: value.maxOutputTokens } }
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
      let preparedInput = parseRunAgentInput(prepared.input)
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
      const countTokens = async () => {
        const count = await this.ctx.llm.countTokens(
          {
            input: preparedInput,
            model: this.config.model,
            maxOutputTokens
          },
          options
        )
        signal.throwIfAborted()
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid input token count')
        return count
      }

      let compaction: CompactionResult | undefined
      if ((await countTokens()) > maxInputTokens) {
        compaction = await this.ctx.compaction.compact(
          {
            input: preparedInput,
            model: this.config.model,
            maxInputTokens
          },
          options
        )
        signal.throwIfAborted()
        preparedInput = parseRunAgentInput({ ...preparedInput, messages: compaction.messages })
        if ((await countTokens()) > maxInputTokens) {
          throw new Error('compacted input still exceeds the model context budget')
        }
      }

      signal.throwIfAborted()
      yield* this.ctx.generation.run(
        {
          input: preparedInput,
          model: this.config.model,
          maxOutputTokens,
          sessionRevision: prepared.revision,
          ...(compaction ? { compaction } : {})
        },
        options
      )
    } finally {
      cleanup()
    }
  }
}

export const simpleAgentPlugin = Object.assign(
  function simpleAgentPlugin(ctx: Context, config: SimpleAgentConfig) {
    new SimpleAgent(ctx, config)
  },
  { inject: ['llm', 'generation', 'session', 'compaction'], Config: simpleAgentConfigSchema }
)

export { simpleAgentConfigSchema as SimpleAgentConfigSchema }
export default simpleAgentPlugin
