import { AgentService } from '@keundal/agent'
import { compact } from '@keundal/compaction'
import type {} from '@keundal/context'
import {
  CONTEXT_MESSAGE_EVENT,
  EventType,
  isContextOverflow,
  CONTEXT_MESSAGE_PREFIX,
  parseRunAgentInput,
  parseReasoning,
  type AGUIEvent,
  type CompactionResult,
  type ExecutionOptions,
  type LLMRequest,
  type LLMEvent,
  type RunAgentInput,
  type SteerQueue
} from '@keundal/core'
import type { ToolProvider } from '@keundal/tools'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { type Context } from 'cordis'

import type { AgentConfig } from './config.js'
export type { AgentConfig, AgentCompactionConfig, CompactionPolicy } from './config.js'
export type { ToolProvider } from '@keundal/tools'

import {
  parseCompactionConfig,
  applyPrepared,
  matchesPrepared,
  waitForPreparation,
  type PreparedCompaction
} from './compaction.js'
import { SYSTEM_PROMPT_ID, withSystemPrompt } from './prompt.js'
import { SKILL_CATALOG_ID, skillTool, withSkillCatalog } from './skills.js'
import { addTools, parseTools, streamWithTools } from './tools.js'

export type { ExecutableTool, ToolExecutionContext } from './tools.js'

/**
 * 에이전트 설정을 검증하고 기본값을 채웁니다. 잘못된 값은 예외로 알립니다.
 */
export function parseAgentConfig(value: unknown): AgentConfig {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('model' in value) ||
    typeof value.model !== 'string' ||
    !value.model.trim() ||
    !('maxOutputTokens' in value) ||
    typeof value.maxOutputTokens !== 'number' ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    value.maxOutputTokens <= 0
  ) {
    throw new Error('model and a positive integer maxOutputTokens are required')
  }
  const compaction = parseCompactionConfig('compaction' in value ? value.compaction : undefined)
  for (const key of ['webSearch', 'skills', 'context'] as const) {
    const option = (value as Record<string, unknown>)[key]
    if (option !== undefined && typeof option !== 'boolean') {
      throw new Error(`${key} must be a boolean`)
    }
  }
  const configuredTools = 'tools' in value ? value.tools : undefined
  const tools = typeof configuredTools === 'function' ? (configuredTools as ToolProvider) : parseTools(configuredTools)
  const skills = 'skills' in value ? (value.skills as boolean | undefined) : undefined
  if (skills && typeof tools !== 'function' && tools.some((tool) => tool.name === 'skill'))
    throw new Error('skill tool name is reserved when skills are enabled')
  const systemPrompt = 'systemPrompt' in value ? value.systemPrompt : undefined
  if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || !systemPrompt.trim())) {
    throw new Error('systemPrompt must be a non-empty string')
  }
  const maxToolRounds = 'maxToolRounds' in value ? value.maxToolRounds : 8
  if (typeof maxToolRounds !== 'number' || !Number.isSafeInteger(maxToolRounds) || maxToolRounds <= 0) {
    throw new Error('maxToolRounds must be a positive integer')
  }
  const maxToolCalls = 'maxToolCalls' in value ? value.maxToolCalls : 32
  if (typeof maxToolCalls !== 'number' || !Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) {
    throw new Error('maxToolCalls must be a positive integer')
  }
  const parallelTools = 'parallelTools' in value ? value.parallelTools : false
  if (typeof parallelTools !== 'boolean') throw new Error('parallelTools must be a boolean')
  return {
    model: value.model,
    maxOutputTokens: value.maxOutputTokens,
    ...('webSearch' in value ? { webSearch: value.webSearch as boolean | undefined } : {}),
    ...('reasoning' in value ? { reasoning: parseReasoning(value.reasoning) } : {}),
    compaction,
    tools,
    skills,
    ...('context' in value ? { context: value.context as boolean | undefined } : {}),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    maxToolRounds,
    maxToolCalls,
    parallelTools
  }
}

const agentConfigSchema: StandardSchemaV1<AgentConfig, AgentConfig> = {
  '~standard': {
    version: 1,
    vendor: 'keundal',
    validate(value) {
      try {
        return { value: parseAgentConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : 'invalid agent config' }] }
      }
    }
  }
}

/**
 * 에이전트 구현의 계약입니다. 도구 실행, 후속 생성, 축약, 스킬을 함께 처리하는 기본 구현을
 * 담고, 다른 에이전트 구현은 이 클래스를 확장해 동작을 바꾼다.
 */
export class Agent extends AgentService {
  private readonly active = new Set<AbortController>()
  private closed = false
  private readonly preparations = new Map<string, PreparedCompaction>()
  private readonly compactionPolicy: ReturnType<Agent['resolveCompactionPolicy']>

  constructor(
    ctx: Context,
    protected readonly config: AgentConfig
  ) {
    super(ctx)
    this.compactionPolicy = this.resolveCompactionPolicy()
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const entry of this.preparations.values()) {
        entry.detach()
        entry.controller.abort(new Error('agent disposed'))
      }
      this.preparations.clear()
      for (const controller of this.active) controller.abort(new Error('agent disposed'))
    })
  }

  /**
   * 모든 실행에 앞서 모델에 전달할 시스템 지침입니다. 구현은 이 값을 바꿀 수 있습니다.
   */
  protected systemPrompt(): string | undefined {
    return this.config.systemPrompt
  }

  run(input: RunAgentInput, options: ExecutionOptions = {}): AsyncIterableIterator<AGUIEvent> {
    if (this.closed) throw new Error('agent disposed')
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
      if (!controller.signal.aborted) controller.abort(new Error('agent run stopped'))
      cleanup()
    }
    const iterator = this.execute(input, controller.signal, stop, options.steer)
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
    cleanup: () => void,
    steer?: SteerQueue
  ): AsyncGenerator<AGUIEvent, void, unknown> {
    try {
      signal.throwIfAborted()
      const request = parseRunAgentInput(input)
      for (const reserved of [SKILL_CATALOG_ID, SYSTEM_PROMPT_ID]) {
        if (request.messages.some((message) => message.id === reserved)) {
          throw new Error(`message id is reserved: ${reserved}`)
        }
      }
      if (request.messages.some((message) => message.id.startsWith(CONTEXT_MESSAGE_PREFIX))) {
        throw new Error('message id is reserved for request context')
      }
      const options = { signal }
      const prepared = await this.ctx.session.prepare(request, options)
      signal.throwIfAborted()
      const configuredTools = parseTools(
        typeof this.config.tools === 'function' ? await this.config.tools(options) : this.config.tools
      )
      signal.throwIfAborted()
      if (this.config.skills && configuredTools.some((tool) => tool.name === 'skill'))
        throw new Error('skill tool name is reserved when skills are enabled')
      const catalog = this.config.skills ? await this.ctx.skills.prepare(options) : undefined
      signal.throwIfAborted()
      const tools = [...configuredTools, ...(catalog ? [skillTool(catalog)] : [])]
      const preparedInput = addTools(
        withSystemPrompt(withSkillCatalog(parseRunAgentInput(prepared.input), catalog), this.systemPrompt()),
        tools
      )
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
      const maxInputTokens = model.contextWindow - maxOutputTokens - (this.compactionPolicy.reserveTokens ?? 0)
      if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0)
        throw new Error('compaction reserveTokens exceeds the model input budget')
      let step = 1
      const contextualInput = this.config.context
        ? await this.ctx.requestContext.prepare(preparedInput, {
            signal,
            step,
            request,
            contextWindow: model.contextWindow
          })
        : preparedInput
      const fitted = await this.fitInput(contextualInput, maxInputTokens, signal)
      const previousIds = this.config.context ? new Set(preparedInput.messages.map((message) => message.id)) : undefined
      const initialContext = previousIds
        ? fitted.input.messages.filter(
            (message) => message.id.startsWith(CONTEXT_MESSAGE_PREFIX) && !previousIds.has(message.id)
          )
        : []
      const llm = this.ctx.llm
      const stream = (request: LLMRequest, execution?: ExecutionOptions) =>
        this.streamWithRetry(request, maxInputTokens, execution?.signal ?? signal)
      const maxToolRounds = this.config.maxToolRounds ?? 8
      const maxToolCalls = this.config.maxToolCalls ?? 32
      const parallel = this.config.parallelTools ?? false
      const prepareNext = async (next: RunAgentInput, generationSignal: AbortSignal) => {
        const contextual = this.config.context
          ? await this.ctx.requestContext.prepare(next, {
              signal: generationSignal,
              step: ++step,
              request,
              contextWindow: model.contextWindow
            })
          : next
        return (await this.fitInput(contextual, maxInputTokens, generationSignal, false, signal)).input
      }

      signal.throwIfAborted()
      const generation = this.ctx.generation.run(
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
          stream: async function* (generationRequest, execution) {
            const generationSignal = execution?.signal ?? signal
            for (const message of initialContext) {
              generationSignal.throwIfAborted()
              yield { type: EventType.CUSTOM, name: CONTEXT_MESSAGE_EVENT, value: message }
            }
            generationSignal.throwIfAborted()
            yield* tools.length
              ? streamWithTools(
                  llm,
                  generationRequest,
                  tools,
                  maxToolRounds,
                  (next) => prepareNext(next, generationSignal),
                  generationSignal,
                  { parallel, stream, maxToolCalls, ...(steer ? { steer: () => steer.take() } : {}) }
                )
              : stream(generationRequest, { signal: generationSignal })
          }
        }
      )
      for await (const event of generation) {
        if (event.type === EventType.RUN_FINISHED) {
          for (const entry of this.preparations.values()) if (entry.sourceSignal === signal) entry.detach()
        }
        yield event
      }
    } finally {
      cleanup()
    }
  }

  private resolveCompactionPolicy() {
    const config = parseCompactionConfig(this.config.compaction)
    return config.models?.[this.config.model] ?? config
  }

  private discardPreparation(threadId: string, entry: PreparedCompaction) {
    if (this.preparations.get(threadId) === entry) this.preparations.delete(threadId)
    entry.detach()
    entry.controller.abort(new Error('compaction preparation discarded'))
  }

  private prepareCompaction(input: RunAgentInput, maxInputTokens: number, inputTokens: number, signal: AbortSignal) {
    if (this.preparations.has(input.threadId)) return
    // 준비 결과와 진행 중 작업의 수를 함께 제한합니다.
    if (this.preparations.size >= 32) {
      const oldest = this.preparations.entries().next().value
      if (oldest) this.discardPreparation(...oldest)
    }
    let snapshot: RunAgentInput
    try {
      snapshot = globalThis.structuredClone(input)
      JSON.stringify(snapshot)
    } catch {
      // 복제·비교할 수 없는 상태는 준비를 생략하고 정상 생성을 계속합니다.
      return
    }
    const controller = new globalThis.AbortController()
    const abort = () => controller.abort(signal.reason)
    const detach = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    const entry: PreparedCompaction = {
      input: snapshot,
      controller,
      sourceSignal: signal,
      detach,
      task: Promise.resolve(undefined)
    }
    this.preparations.set(input.threadId, entry)
    entry.task = compact(
      this.ctx.llm,
      {
        input: entry.input,
        model: this.config.model,
        maxInputTokens
      },
      { ...this.compactionPolicy, signal: controller.signal, inputTokens, force: true }
    ).then(
      (result) => {
        if (!controller.signal.aborted && this.preparations.get(input.threadId) === entry) entry.result = result
        detach()
        return entry.result
      },
      () => {
        detach()
        // 준비 실패는 실제 생성에 영향을 주지 않습니다. 필요해지면 동기 축약으로 재시도합니다.
        if (this.preparations.get(input.threadId) === entry) this.preparations.delete(input.threadId)
        return undefined
      }
    )
  }

  private async *streamWithRetry(
    request: LLMRequest,
    maxInputTokens: number,
    signal: AbortSignal
  ): AsyncGenerator<LLMEvent> {
    let emitted = false
    try {
      for await (const event of this.ctx.llm.stream(request, { signal })) {
        signal.throwIfAborted()
        emitted = true
        yield event
      }
    } catch (error) {
      signal.throwIfAborted()
      if (emitted || !isContextOverflow(error)) throw error
      const fitted = await this.fitInput(request.input, maxInputTokens, signal, true)
      signal.throwIfAborted()
      yield* this.ctx.llm.stream({ ...request, input: fitted.input }, { signal })
    }
  }

  private async fitInput(
    input: RunAgentInput,
    maxInputTokens: number,
    signal: AbortSignal,
    force = false,
    backgroundSignal = signal
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
    const entry = this.preparations.get(input.threadId)
    if (entry && matchesPrepared(entry, input)) {
      if (count > maxInputTokens || force) await waitForPreparation(entry.task, signal)
      signal.throwIfAborted()
      const ready = applyPrepared(entry, input)
      if (entry.result && !ready) this.discardPreparation(input.threadId, entry)
      if (ready) {
        const candidate = { ...input, messages: ready.messages }
        const tokens = await countTokens(candidate)
        this.discardPreparation(input.threadId, entry)
        if (tokens <= maxInputTokens && tokens < count) return { input: candidate, compaction: ready }
      }
    } else if (entry) this.discardPreparation(input.threadId, entry)
    if (!force && count <= maxInputTokens) {
      const policy = this.compactionPolicy
      if (
        count >= maxInputTokens * (policy.threshold ?? 0.8) &&
        input.messages.length > (policy.keepRecentMessages ?? 6) &&
        input.messages.filter((message) => message.role === 'user' && !message.id.startsWith(CONTEXT_MESSAGE_PREFIX))
          .length > 1
      )
        this.prepareCompaction(input, maxInputTokens, count, backgroundSignal)
      return { input }
    }

    const compaction = await compact(
      this.ctx.llm,
      {
        input,
        model: this.config.model,
        maxInputTokens
      },
      { ...this.compactionPolicy, signal, inputTokens: count, force }
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

/** 에이전트 구현이 지켜야 할 생성자 계약입니다. */
export type AgentImplementation = new (ctx: Context, config: AgentConfig) => AgentService

/**
 * 에이전트 구현을 `ctx.agent`로 등록합니다. 스킬을 켜면 `skills` 서비스를 기다리는 동안 에이전트를
 * 준비하고, 서비스가 사라지면 진행 중 실행을 취소합니다.
 */
export function registerAgent(ctx: Context, config: AgentConfig, implementation: AgentImplementation = Agent): void {
  const required = [...(config.skills ? ['skills'] : []), ...(config.context ? ['requestContext'] : [])]
  if (required.length) {
    ctx.inject(required, (injected) => {
      new implementation(injected, config)
    })
  } else {
    new implementation(ctx, config)
  }
}

export { agentConfigSchema as AgentConfigSchema }
