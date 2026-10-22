import { AgentService } from '@keundal/agent'
import { compact } from '@keundal/compaction'
import type {} from '@keundal/context'
import {
  CONTEXT_MESSAGE_EVENT,
  CONTEXT_MESSAGE_PREFIX,
  EventType,
  isContextOverflow,
  LLM_USAGE_EVENT,
  TRACE_EVENT,
  parseRunAgentInput,
  parseReasoning,
  traceEvent,
  type AGUIEvent,
  type CompactionResult,
  type ExecutionOptions,
  type LLMRequest,
  type LLMEvent,
  type RunAgentInput,
  type SteerQueue,
  type TraceMetadataEvent,
  type TraceCost,
  type TraceErrorCategory,
  type TraceSpan,
  type TraceUsage,
  type LLMService
} from '@keundal/core'
import { createDeferredToolSession, parseDeferredToolsConfig, type ToolProvider } from '@keundal/tools'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { type Context } from 'cordis'

import type { AgentConfig, AgentPricing } from './config.js'
export type { AgentConfig, AgentCompactionConfig, AgentPricing, CompactionPolicy, ModelPrice } from './config.js'
export type { ToolProvider } from '@keundal/tools'

import {
  parseCompactionConfig,
  applyPrepared,
  matchesPrepared,
  waitForPreparation,
  type PreparedCompaction
} from './compaction.js'
import { estimateCost, parsePricing } from './pricing.js'
import { SYSTEM_PROMPT_ID, withSystemPrompt } from './prompt.js'
import { SKILL_CATALOG_ID, skillTool, withSkillCatalog } from './skills.js'
import { subagentTool, SUBAGENT_TOOL_NAME } from './subagents.js'
import { addTools, parseTools, streamWithTools } from './tools.js'

export { TOOL_PROGRESS_EVENT } from './tools.js'
export type { ExecutableTool, ToolExecutionContext } from './tools.js'

type TraceParent = { readonly traceId: string; readonly parentSpanId: string }

class TraceRecorder {
  readonly traceId: string
  readonly root: TraceSpan
  lastModelSpanId?: string
  private sequence = 0
  private pending: TraceMetadataEvent[] = []
  private active = new Map<string, TraceSpan>()

  constructor(
    readonly runId: string,
    parent?: TraceParent,
    private readonly pricing?: AgentPricing
  ) {
    this.traceId = parent?.traceId ?? globalThis.crypto.randomUUID()
    this.root = this.start('agent', 'agent', parent?.parentSpanId)
  }

  /** 공급자 비용이 없을 때 가격표로 모델 호출의 비용을 추정합니다. */
  estimateCost(model: string, usage: TraceUsage): TraceCost | undefined {
    return estimateCost(this.pricing, model, usage)
  }

  start(
    kind: TraceSpan['kind'],
    name: string,
    parentSpanId?: string,
    toolCallId?: string,
    model?: string,
    enqueue = true,
    detached = false
  ): TraceSpan {
    const span: TraceSpan = {
      version: 1,
      traceId: this.traceId,
      spanId: globalThis.crypto.randomUUID(),
      ...(parentSpanId ? { parentSpanId } : {}),
      runId: this.runId,
      ...(toolCallId ? { toolCallId } : {}),
      kind,
      name,
      sequence: this.sequence++,
      startedAt: Date.now(),
      status: 'running',
      ...(model ? { model } : {}),
      ...(detached ? { detached: true } : {})
    }
    if (enqueue) this.pending.push(traceEvent(span))
    this.active.set(span.spanId, span)
    return span
  }

  finish(
    span: TraceSpan,
    status: TraceSpan['status'],
    options: { usage?: TraceUsage; cost?: TraceCost; ttftMs?: number; error?: TraceErrorCategory } = {},
    enqueue = true
  ): TraceSpan {
    const current = this.active.get(span.spanId)
    if (!current) return span
    const completed: TraceSpan = {
      ...current,
      endedAt: Date.now(),
      status,
      ...(options.usage ? { usage: options.usage } : {}),
      ...(options.cost ? { cost: options.cost } : {}),
      ...(options.ttftMs === undefined ? {} : { ttftMs: options.ttftMs }),
      ...(options.error ? { error: options.error } : {})
    }
    this.active.delete(span.spanId)
    if (enqueue) this.pending.push(traceEvent(completed))
    return completed
  }

  finishOpenSpans(exceptSpanId: string): void {
    for (const span of this.active.values()) {
      if (span.spanId !== exceptSpanId && !span.detached) this.finish(span, 'interrupted')
    }
  }

  updateUsage(span: TraceSpan, usage: TraceUsage, cost?: TraceCost): void {
    const active = this.active.get(span.spanId)
    if (!active) return
    // 새 사용량으로 비용을 다시 계산하므로 이전 사용량의 비용을 남기지 않습니다.
    const { cost: _previous, ...rest } = active
    const updated = { ...rest, usage, ...(cost ? { cost } : {}) }
    this.active.set(span.spanId, updated)
    this.pending.push(traceEvent(updated))
  }

  drain(): TraceMetadataEvent[] {
    return this.pending.splice(0)
  }
}

function usageFromEvent(value: unknown): { usage: TraceUsage; cost?: TraceCost } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (source.source !== 'provider' && source.source !== 'estimate') return undefined
  const usage: {
    source: TraceUsage['source']
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  } = { source: source.source }
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const count = source[field]
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) usage[field] = count
  }
  const valueCost = source.cost
  const cost =
    typeof valueCost === 'object' && valueCost !== null && !Array.isArray(valueCost)
      ? (valueCost as Record<string, unknown>)
      : undefined
  const safeCost =
    cost &&
    typeof cost.currency === 'string' &&
    cost.currency.trim() &&
    typeof cost.amount === 'number' &&
    Number.isFinite(cost.amount) &&
    cost.amount >= 0 &&
    (cost.source === 'provider' || cost.source === 'estimate')
      ? { currency: cost.currency, amount: cost.amount, source: cost.source }
      : undefined
  return { usage, ...(safeCost ? { cost: safeCost as TraceCost } : {}) }
}

function safeTraceError(error: unknown): TraceErrorCategory {
  return isContextOverflow(error) ? 'context_overflow' : 'provider_error'
}

async function* tracedModelStream(
  stream: AsyncIterable<LLMEvent>,
  model: string,
  trace: TraceRecorder,
  parentSpanId: string,
  signal: AbortSignal,
  publishTraceEvents = true,
  detached = false
): AsyncGenerator<LLMEvent> {
  const span = trace.start('model', 'generate', parentSpanId, undefined, model, true, detached)
  if (publishTraceEvents) trace.lastModelSpanId = span.spanId
  if (publishTraceEvents) yield* trace.drain()
  let usage: TraceUsage | undefined
  let providerCost: TraceCost | undefined
  let cost: TraceCost | undefined
  let ttftMs: number | undefined
  try {
    for await (const event of stream) {
      if (event.type === EventType.CUSTOM && event.name === LLM_USAGE_EVENT) {
        const parsed = usageFromEvent(event.value)
        if (parsed) {
          usage = parsed.usage
          // 공급자가 준 비용이 있으면 가격표 추정으로 덮어쓰지 않습니다.
          providerCost = parsed.cost ?? providerCost
          cost = providerCost ?? trace.estimateCost(model, usage)
          trace.updateUsage(span, usage, cost)
        }
      } else if (
        ttftMs === undefined &&
        (event.type === EventType.TEXT_MESSAGE_CONTENT ||
          event.type === EventType.REASONING_MESSAGE_CONTENT ||
          event.type === EventType.TOOL_CALL_ARGS)
      ) {
        ttftMs = Math.max(0, Date.now() - span.startedAt)
      }
      yield event
      if (publishTraceEvents) yield* trace.drain()
    }
    trace.finish(span, 'completed', {
      ...(usage ? { usage } : {}),
      ...(cost ? { cost } : {}),
      ...(ttftMs === undefined ? {} : { ttftMs })
    })
    if (publishTraceEvents) yield* trace.drain()
  } catch (error) {
    trace.finish(span, signal.aborted ? 'cancelled' : 'failed', {
      ...(usage ? { usage } : {}),
      ...(cost ? { cost } : {}),
      ...(ttftMs === undefined ? {} : { ttftMs }),
      ...(signal.aborted ? {} : { error: safeTraceError(error) })
    })
    if (publishTraceEvents) yield* trace.drain()
    throw error
  }
}

function tracedCompactionLLM(
  llm: LLMService,
  trace: TraceRecorder,
  parentSpanId: string,
  signal: AbortSignal,
  detached = false
): Pick<LLMService, 'getModel' | 'countTokens' | 'stream'> {
  return {
    getModel: (model, options) => llm.getModel(model, options),
    countTokens: (request, options) => llm.countTokens(request, options),
    stream: (request, options) =>
      tracedModelStream(
        llm.stream(request, options),
        request.model,
        trace,
        parentSpanId,
        options?.signal ?? signal,
        false,
        detached
      )
  }
}

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
  for (const key of ['webSearch', 'skills', 'context', 'subagents'] as const) {
    const option = (value as Record<string, unknown>)[key]
    if (option !== undefined && typeof option !== 'boolean') {
      throw new Error(`${key} must be a boolean`)
    }
  }
  const configuredTools = 'tools' in value ? value.tools : undefined
  const deferredTools =
    'deferredTools' in value && value.deferredTools !== undefined
      ? parseDeferredToolsConfig(value.deferredTools)
      : undefined
  const deferredToolProvider = 'deferredToolProvider' in value ? value.deferredToolProvider : undefined
  if (deferredToolProvider !== undefined && typeof deferredToolProvider !== 'function') {
    throw new Error('deferredToolProvider must be a function')
  }
  if ((deferredToolProvider === undefined) !== (deferredTools === undefined)) {
    throw new Error('deferredTools and deferredToolProvider must be configured together')
  }
  const tools = typeof configuredTools === 'function' ? (configuredTools as ToolProvider) : parseTools(configuredTools)
  const maxActiveSubagents =
    'maxActiveSubagents' in value && value.maxActiveSubagents !== undefined ? value.maxActiveSubagents : 8
  if (typeof maxActiveSubagents !== 'number' || !Number.isSafeInteger(maxActiveSubagents) || maxActiveSubagents <= 0)
    throw new Error('maxActiveSubagents must be a positive integer')
  const subagents = 'subagents' in value ? (value.subagents as boolean | undefined) : undefined
  if (subagents && typeof tools !== 'function' && tools.some((tool) => tool.name === SUBAGENT_TOOL_NAME))
    throw new Error('delegate_task tool name is reserved when subagents are enabled')
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
  const pricing = 'pricing' in value && value.pricing !== undefined ? parsePricing(value.pricing) : undefined
  return {
    model: value.model,
    maxOutputTokens: value.maxOutputTokens,
    ...('webSearch' in value ? { webSearch: value.webSearch as boolean | undefined } : {}),
    ...('reasoning' in value ? { reasoning: parseReasoning(value.reasoning) } : {}),
    compaction,
    tools,
    ...(deferredTools === undefined ? {} : { deferredTools }),
    ...(deferredToolProvider === undefined ? {} : { deferredToolProvider: deferredToolProvider as ToolProvider }),
    subagents,
    maxActiveSubagents,
    skills,
    ...('context' in value ? { context: value.context as boolean | undefined } : {}),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    maxToolRounds,
    maxToolCalls,
    parallelTools,
    ...(pricing === undefined ? {} : { pricing })
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
    return this.runInternal(input, options, true)
  }

  private runInternal(
    input: RunAgentInput,
    options: ExecutionOptions & Partial<TraceParent>,
    allowSubagents: boolean
  ): AsyncIterableIterator<AGUIEvent> {
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
    const traceParent =
      options.traceId && options.parentSpanId
        ? { traceId: options.traceId, parentSpanId: options.parentSpanId }
        : undefined
    const iterator = this.execute(input, controller.signal, stop, allowSubagents, traceParent, options.steer)
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
    allowSubagents: boolean,
    traceParent?: TraceParent,
    steer?: SteerQueue
  ): AsyncGenerator<AGUIEvent, void, unknown> {
    let failedTrace: TraceRecorder | undefined
    let rootFinalized = false
    try {
      signal.throwIfAborted()
      const request = parseRunAgentInput(input)
      const trace = new TraceRecorder(request.runId, traceParent, this.config.pricing)
      failedTrace = trace
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
      const deferredSession = this.config.deferredToolProvider
        ? await createDeferredToolSession(this.config.deferredToolProvider, options, this.config.deferredTools)
        : undefined
      if (deferredSession && configuredTools.some((tool) => tool.name === 'search_tool')) {
        throw new Error('search_tool is reserved when deferred tools are enabled')
      }
      if (this.config.skills && configuredTools.some((tool) => tool.name === 'skill'))
        throw new Error('skill tool name is reserved when skills are enabled')
      if (this.config.subagents && configuredTools.some((tool) => tool.name === SUBAGENT_TOOL_NAME))
        throw new Error('delegate_task tool name is reserved when subagents are enabled')
      const catalog = this.config.skills ? await this.ctx.skills.prepare(options) : undefined
      signal.throwIfAborted()
      const tools = [
        ...configuredTools,
        ...(catalog ? [skillTool(catalog)] : []),
        ...(this.config.subagents && allowSubagents
          ? [
              subagentTool(
                (child, execution) => this.runInternal(child, execution, false),
                this.config.maxActiveSubagents ?? 8
              )
            ]
          : []),
        ...(deferredSession ? [deferredSession.searchTool] : [])
      ]
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
      const fitted = await this.fitInput(contextualInput, maxInputTokens, signal, false, signal, trace)
      const previousIds = this.config.context ? new Set(preparedInput.messages.map((message) => message.id)) : undefined
      const initialContext = previousIds
        ? fitted.input.messages.filter(
            (message) => message.id.startsWith(CONTEXT_MESSAGE_PREFIX) && !previousIds.has(message.id)
          )
        : []
      const llm = this.ctx.llm
      const stream = (request: LLMRequest, execution?: ExecutionOptions) =>
        this.streamWithRetry(request, maxInputTokens, execution?.signal ?? signal, trace!)
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
        return (await this.fitInput(contextual, maxInputTokens, generationSignal, false, signal, trace)).input
      }

      const toolSpans = new Map<string, TraceSpan>()
      const traceContext = (call: { id: string; name: string }) => {
        const span = trace.start(
          'tool',
          call.name,
          trace.lastModelSpanId ?? trace.root.spanId,
          call.id,
          undefined,
          false
        )
        toolSpans.set(call.id, span)
        return { traceId: trace.traceId, parentSpanId: span.spanId }
      }
      const traceHooks = {
        onToolStart(call: { id: string; name: string }) {
          const span = toolSpans.get(call.id)
          return span ? traceEvent(span) : undefined
        },
        onToolEnd(call: { id: string; name: string; status: 'completed' | 'failed' | 'cancelled' }) {
          const span = toolSpans.get(call.id)
          if (!span) return undefined
          toolSpans.delete(call.id)
          const ended = trace.finish(span, call.status, call.status === 'failed' ? { error: 'tool_error' } : {}, false)
          return traceEvent(ended)
        }
      }
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
            yield* trace.drain()
            try {
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
                    {
                      parallel,
                      stream,
                      maxToolCalls,
                      ...(steer ? { steer: () => steer.take() } : {}),
                      ...(deferredSession
                        ? {
                            resolveTools: async () => {
                              await deferredSession.refresh()
                              return deferredSession.activeTools
                            }
                          }
                        : {}),
                      traceContext,
                      trace: traceHooks
                    }
                  )
                : stream(generationRequest, { signal: generationSignal })
              trace.finishOpenSpans(trace.root.spanId)
              trace.finish(trace.root, 'completed')
              rootFinalized = true
              yield* trace.drain()
            } catch (error) {
              trace.finishOpenSpans(trace.root.spanId)
              const status = generationSignal.aborted ? 'cancelled' : 'failed'
              trace.finish(trace.root, status, status === 'failed' ? { error: 'agent_error' } : {})
              rootFinalized = true
              yield* trace.drain()
              throw error
            }
          }
        }
      )
      for await (const event of generation) {
        if ((event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) && !rootFinalized) {
          const status =
            event.type === EventType.RUN_ERROR
              ? 'failed'
              : signal.aborted
                ? 'cancelled'
                : event.outcome?.type === 'success'
                  ? 'completed'
                  : 'failed'
          trace.finishOpenSpans(trace.root.spanId)
          trace.finish(trace.root, status, status === 'failed' ? { error: 'agent_error' } : {})
          rootFinalized = true
          yield* trace.drain()
        }
        if (event.type === EventType.RUN_FINISHED) {
          for (const entry of this.preparations.values()) if (entry.sourceSignal === signal) entry.detach()
        }
        yield event
      }
    } catch (error) {
      if (failedTrace && !rootFinalized) {
        const status = signal.aborted ? 'cancelled' : 'failed'
        failedTrace.finishOpenSpans(failedTrace.root.spanId)
        failedTrace.finish(failedTrace.root, status, status === 'failed' ? { error: 'agent_error' } : {})
        rootFinalized = true
      }
      throw error
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

  private prepareCompaction(
    input: RunAgentInput,
    maxInputTokens: number,
    inputTokens: number,
    signal: AbortSignal,
    trace?: TraceRecorder
  ) {
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
    const span = trace?.start('compaction', 'background_prepare', trace.root.spanId, undefined, undefined, true, true)
    const compactionLLM =
      span && trace ? tracedCompactionLLM(this.ctx.llm, trace, span.spanId, controller.signal, true) : this.ctx.llm
    entry.task = compact(
      compactionLLM,
      {
        input: entry.input,
        model: this.config.model,
        maxInputTokens
      },
      { ...this.compactionPolicy, signal: controller.signal, inputTokens, force: true }
    ).then(
      (result) => {
        if (!controller.signal.aborted && this.preparations.get(input.threadId) === entry) entry.result = result
        if (span && trace) trace.finish(span, controller.signal.aborted ? 'cancelled' : 'completed')
        detach()
        return entry.result
      },
      () => {
        if (span && trace)
          trace.finish(
            span,
            controller.signal.aborted ? 'cancelled' : 'failed',
            controller.signal.aborted ? {} : { error: 'compaction_error' }
          )
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
    signal: AbortSignal,
    trace: TraceRecorder
  ): AsyncGenerator<LLMEvent> {
    let emitted = false
    try {
      for await (const event of tracedModelStream(
        this.ctx.llm.stream(request, { signal }),
        request.model,
        trace,
        trace.root.spanId,
        signal
      )) {
        signal.throwIfAborted()
        if (!(event.type === EventType.CUSTOM && (event.name === TRACE_EVENT || event.name === LLM_USAGE_EVENT)))
          emitted = true
        yield event
      }
    } catch (error) {
      signal.throwIfAborted()
      if (emitted || !isContextOverflow(error)) throw error
      const fitted = await this.fitInput(request.input, maxInputTokens, signal, true, signal, trace)
      signal.throwIfAborted()
      yield* tracedModelStream(
        this.ctx.llm.stream({ ...request, input: fitted.input }, { signal }),
        request.model,
        trace,
        trace.root.spanId,
        signal
      )
    }
  }

  private async fitInput(
    input: RunAgentInput,
    maxInputTokens: number,
    signal: AbortSignal,
    force = false,
    backgroundSignal = signal,
    trace?: TraceRecorder
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
        this.prepareCompaction(input, maxInputTokens, count, backgroundSignal, trace)
      return { input }
    }

    const compactionSpan = trace?.start('compaction', 'compact', trace.root.spanId)
    let compaction: CompactionResult
    const compactionLLM =
      compactionSpan && trace ? tracedCompactionLLM(this.ctx.llm, trace, compactionSpan.spanId, signal) : this.ctx.llm
    try {
      compaction = await compact(
        compactionLLM,
        { input, model: this.config.model, maxInputTokens },
        { ...this.compactionPolicy, signal, inputTokens: count, force }
      )
    } catch (error) {
      if (compactionSpan && trace) {
        trace.finish(
          compactionSpan,
          signal.aborted ? 'cancelled' : 'failed',
          signal.aborted ? {} : { error: 'compaction_error' }
        )
      }
      throw error
    }
    if (compactionSpan && trace) trace.finish(compactionSpan, 'completed')
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
