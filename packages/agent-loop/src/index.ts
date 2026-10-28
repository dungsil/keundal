import { AgentService, type AgentExecutionOptions } from '@keundal/agent'
import { SummaryCompactionController } from '@keundal/compaction-summary/controller'
import type {} from '@keundal/context'
import {
  CONTEXT_MESSAGE_EVENT,
  CONTEXT_MESSAGE_PREFIX,
  EventType,
  parseRunAgentInput,
  type AGUIEvent,
  type ExecutionOptions,
  type RunAgentInput,
  type SteerQueue
} from '@keundal/core'
import { createDeferredToolSession } from '@keundal/deferred-tools'
import type {} from '@keundal/generation'
import type { LLMRequest } from '@keundal/llm'
import { PROMPT_MESSAGE_PREFIX, assemblePrompt, parsePromptPreset } from '@keundal/prompt'
import type {} from '@keundal/session'
import { SKILL_CATALOG_ID, skillTool, withSkillCatalog } from '@keundal/skill/tools'
import { parseSubagentRoles } from '@keundal/subagent'
import { subagentTool, SUBAGENT_TOOL_NAME } from '@keundal/subagent/tools'
import { addTools, parseTools, streamWithTools } from '@keundal/tool-execution'
import { traceEvent, type TraceSpan } from '@keundal/trace'
import { TraceRecorder, type TraceParent } from '@keundal/trace/recording'
import type { Context } from 'cordis'

import { BudgetLedger, parseRunBudget } from './budget.js'
import type { AgentConfig } from './config.js'
import { SYSTEM_PROMPT_ID, withSystemPrompt } from './prompt.js'

export type { AgentConfig } from './config.js'
export type { ToolProvider, ExecutableTool, ToolExecutionContext } from '@keundal/tools'
export { TOOL_PROGRESS_EVENT } from '@keundal/tools'

/**
 * 에이전트 구현의 계약입니다. 도구 실행, 후속 생성, 축약, 스킬을 함께 처리하는 기본 구현을
 * 담고, 다른 에이전트 구현은 이 클래스를 확장해 동작을 바꾼다.
 */
export class Agent extends AgentService {
  private readonly active = new Set<AbortController>()
  private closed = false
  private readonly compaction: SummaryCompactionController

  constructor(
    ctx: Context,
    protected readonly config: AgentConfig
  ) {
    super(ctx)
    this.compaction = new SummaryCompactionController(ctx.llm, config)
    ctx.fiber.effect(() => () => {
      this.closed = true
      this.compaction.dispose()
      for (const controller of this.active) controller.abort(new Error('agent disposed'))
    })
  }

  /**
   * 모든 실행에 앞서 모델에 전달할 시스템 지침입니다. 구현은 이 값을 바꿀 수 있습니다.
   */
  protected systemPrompt(): string | undefined {
    return this.config.systemPrompt
  }

  run(input: RunAgentInput, options: AgentExecutionOptions = {}): AsyncIterableIterator<AGUIEvent> {
    return this.runInternal(input, options, true)
  }

  private runInternal(
    input: RunAgentInput,
    options: AgentExecutionOptions & Partial<TraceParent>,
    allowSubagents: boolean,
    budget?: BudgetLedger
  ): AsyncIterableIterator<AGUIEvent> {
    if (this.closed) throw new Error('agent disposed')
    const controller = new globalThis.AbortController()
    const policy = !budget && (options.budget ?? this.config.budget)
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    if (policy) {
      const parsed = parseRunBudget(policy)
      budget = new BudgetLedger(parsed, this.config.pricing, (reason) => controller.abort(reason))
      if (parsed.maxDurationMs !== undefined) {
        timer = globalThis.setTimeout(
          () => controller.abort(new Error('run budget exceeded: duration')),
          parsed.maxDurationMs
        )
      }
    }
    const externalSignal = options.signal
    const abort = () => controller.abort(externalSignal?.reason)
    const cleanup = () => {
      globalThis.clearTimeout(timer)
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
    const iterator = this.execute(input, controller.signal, stop, allowSubagents, traceParent, options.steer, budget)
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
    steer?: SteerQueue,
    budget?: BudgetLedger
  ): AsyncGenerator<AGUIEvent, void, unknown> {
    let failedTrace: TraceRecorder | undefined
    let rootFinalized = false
    const llm = budget ? budget.wrap(this.ctx.llm) : this.ctx.llm
    const compaction = budget ? new SummaryCompactionController(llm, this.config) : this.compaction
    try {
      signal.throwIfAborted()
      const request = parseRunAgentInput(input)
      const presetValue: unknown =
        this.config.promptPresets === false ? undefined : request.forwardedProps?.keundalPromptPreset
      const promptPreset = presetValue === undefined ? undefined : parsePromptPreset(presetValue)
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
      if (request.messages.some((message) => message.id.startsWith(PROMPT_MESSAGE_PREFIX))) {
        throw new Error('message id is reserved for prompt presets')
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
                (child, execution) => this.runInternal(child, execution, false, budget),
                this.config.maxActiveSubagents ?? 8,
                request.state?.subagentRoles === undefined
                  ? this.config.subagentRoles
                  : parseSubagentRoles(request.state.subagentRoles)
              )
            ]
          : []),
        ...(deferredSession ? [deferredSession.searchTool] : [])
      ]
      let preparedInput = addTools(
        withSystemPrompt(withSkillCatalog(parseRunAgentInput(prepared.input), catalog), this.systemPrompt()),
        tools
      )
      if (promptPreset)
        preparedInput = { ...preparedInput, messages: assemblePrompt(preparedInput.messages, promptPreset) }
      if (preparedInput.threadId !== request.threadId || preparedInput.runId !== request.runId) {
        throw new Error('session preparation must preserve threadId and runId')
      }
      if (!Number.isSafeInteger(prepared.revision) || prepared.revision < 0) {
        throw new Error('session revision must be a non-negative integer')
      }

      const model = await llm.getModel(this.config.model, options)
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
      const maxInputTokens = model.contextWindow - maxOutputTokens - (compaction.policy.reserveTokens ?? 0)
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
      const fitted = await compaction.fitInput(contextualInput, maxInputTokens, signal, false, signal, trace)
      const previousIds = this.config.context ? new Set(preparedInput.messages.map((message) => message.id)) : undefined
      const initialContext = previousIds
        ? fitted.input.messages.filter(
            (message) => message.id.startsWith(CONTEXT_MESSAGE_PREFIX) && !previousIds.has(message.id)
          )
        : []
      const stream = (request: LLMRequest, execution?: ExecutionOptions) =>
        compaction.streamWithRetry(request, maxInputTokens, execution?.signal ?? signal, trace!)
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
        return (await compaction.fitInput(contextual, maxInputTokens, generationSignal, false, signal, trace)).input
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
      const approval = this.config.toolApproval
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
                      approval,
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
          if (!budget) compaction.detach(signal)
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
      if (budget) compaction.dispose()
      cleanup()
    }
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

export { AgentConfigSchema, parseAgentConfig } from './config.js'
