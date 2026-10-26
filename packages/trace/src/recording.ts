import { EventType } from '@keundal/core'
import { isContextOverflow, type LLMService, type LLMEvent } from '@keundal/llm'

import { estimateCost, type AgentPricing } from './pricing.js'
import {
  LLM_USAGE_EVENT,
  traceEvent,
  type TraceSpan,
  type TraceMetadataEvent,
  type TraceUsage,
  type TraceCost,
  type TraceErrorCategory
} from './trace.js'

export type TraceParent = { readonly traceId: string; readonly parentSpanId: string }

export class TraceRecorder {
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

export async function* tracedModelStream(
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

export function tracedCompactionLLM(
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
