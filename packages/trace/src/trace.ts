import { EventType, type AGUIEvent } from '@keundal/core'
import type { GenerationJournalEntry, GenerationStatus } from '@keundal/generation'

export const TRACE_EVENT = 'keundal.trace'
export const LLM_USAGE_EVENT = 'keundal.llm.usage'

export interface TraceUsage {
  readonly source: 'provider' | 'estimate'
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export interface TraceCost {
  readonly currency: string
  readonly amount: number
  readonly source: 'provider' | 'estimate'
}

export type TraceErrorCategory =
  | 'context_overflow'
  | 'provider_error'
  | 'tool_error'
  | 'compaction_error'
  | 'agent_error'

export interface TraceSpan {
  readonly version: 1
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly runId: string
  readonly toolCallId?: string
  readonly kind: 'agent' | 'model' | 'tool' | 'compaction'
  readonly name: string
  readonly sequence: number
  readonly startedAt: number
  readonly endedAt?: number
  readonly detached?: boolean
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly model?: string
  readonly usage?: TraceUsage
  readonly cost?: TraceCost
  readonly ttftMs?: number
  readonly error?: TraceErrorCategory
}

export interface TraceSummary {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly usageSource: 'provider' | 'estimate' | 'mixed' | 'unknown'
  readonly cost?: {
    readonly currency: string
    readonly amount: number
    readonly complete: boolean
    readonly source: 'provider' | 'estimate' | 'mixed'
  }
  readonly durationMs?: number
}

export type TraceMetadataEvent = Extract<AGUIEvent, { type: 'CUSTOM' }>

export function traceEvent(span: TraceSpan): TraceMetadataEvent {
  return { type: EventType.CUSTOM, name: TRACE_EVENT, value: { version: 1, span } }
}

export function llmUsageEvent(value: TraceUsage & { readonly cost?: TraceCost }): TraceMetadataEvent {
  return { type: EventType.CUSTOM, name: LLM_USAGE_EVENT, value }
}

export function readTraceSpans(events: Iterable<AGUIEvent>, runId?: string, maxSpans = 1000): TraceSpan[] {
  const limit = Number.isSafeInteger(maxSpans) ? Math.min(10000, Math.max(0, maxSpans)) : 1000
  const latest = new Map<string, TraceSpan>()
  for (const event of events) {
    if (event.type !== EventType.CUSTOM || event.name !== TRACE_EVENT) continue
    const value = event.value
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.span)) continue
    const span = value.span
    if (!validSpan(span) || (runId !== undefined && span.runId !== runId)) continue
    const projected = projectSpan(span)
    latest.delete(projected.spanId)
    latest.set(projected.spanId, projected)
    if (latest.size > limit) latest.delete(latest.keys().next().value!)
  }
  return [...latest.values()].sort((a, b) => a.sequence - b.sequence || a.spanId.localeCompare(b.spanId))
}

export function reconcileTerminalTraceJournal(
  journal: readonly GenerationJournalEntry[],
  status: GenerationStatus
): GenerationJournalEntry[] {
  if (status === 'running') return [...journal]
  const reconciled = [...journal]
  for (let index = reconciled.length - 1; index >= 0; index--) {
    const entry = reconciled[index]!
    const event = entry.event
    if (event.type !== EventType.CUSTOM || event.name !== TRACE_EVENT) continue
    const value = event.value
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.span)) continue
    const span = value.span
    if (span.kind !== 'agent' || span.sequence !== 0 || typeof span.spanId !== 'string') continue
    reconciled[index] = {
      ...entry,
      event: { ...event, value: { ...value, span: { ...span, status } } } as AGUIEvent
    }
    break
  }
  return reconciled
}

export function summarizeTrace(spans: readonly TraceSpan[]): TraceSummary {
  const unique = new Map<string, TraceSpan>()
  for (const span of spans) if (validSpan(span)) unique.set(span.spanId, span)
  const values = [...unique.values()]
  const models = values.filter((span) => span.kind === 'model')
  const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
  const sums: Partial<Record<(typeof usageFields)[number], number>> = {}
  const hasUsage = models.map((span) => span.usage)
  for (const field of usageFields) {
    const known = hasUsage.flatMap((usage) => (usage && isCount(usage[field]) ? [usage[field]!] : []))
    if (known.length) sums[field] = known.reduce((total, count) => total + count, 0)
  }
  const sources = new Set(hasUsage.flatMap((usage) => (usage ? [usage.source] : [])))
  const usageComplete = models.length > 0 && hasUsage.every((usage) => usage !== undefined)
  const usageSource =
    sources.size === 0 ? 'unknown' : !usageComplete ? 'unknown' : sources.size === 1 ? [...sources][0]! : 'mixed'
  const costs = models.flatMap((span) => (span.cost ? [span.cost] : []))
  let cost: TraceSummary['cost']
  if (costs.length) {
    const currencies = new Set(costs.map((entry) => entry.currency))
    if (currencies.size === 1) {
      const costSources = new Set(costs.map((entry) => entry.source))
      cost = {
        currency: costs[0]!.currency,
        amount: costs.reduce((total, entry) => total + entry.amount, 0),
        complete:
          costs.length === models.length &&
          usageComplete &&
          models.every((span) => span.status !== 'running' && span.endedAt !== undefined),
        source: costSources.size === 1 ? [...costSources][0]! : 'mixed'
      }
    }
  }
  const root = values.find((span) => span.kind === 'agent' && span.parentSpanId === undefined)
  const durationMs = root?.endedAt === undefined ? undefined : root.endedAt - root.startedAt
  const result: TraceSummary = {
    ...sums,
    usageSource,
    ...(cost ? { cost } : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  }
  return result
}

function projectSpan(value: TraceSpan): TraceSpan {
  const usage = value.usage
  const cost = value.cost
  return {
    version: 1,
    traceId: value.traceId,
    spanId: value.spanId,
    ...(value.parentSpanId === undefined ? {} : { parentSpanId: value.parentSpanId }),
    runId: value.runId,
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
    kind: value.kind,
    name: value.name,
    sequence: value.sequence,
    startedAt: value.startedAt,
    ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt }),
    ...(value.detached === undefined ? {} : { detached: value.detached }),
    status: value.status,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(usage === undefined
      ? {}
      : {
          usage: {
            source: usage.source,
            ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
            ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
            ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
            ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens })
          }
        }),
    ...(cost === undefined
      ? {}
      : {
          cost: { currency: cost.currency, amount: cost.amount, source: cost.source }
        }),
    ...(value.ttftMs === undefined ? {} : { ttftMs: value.ttftMs }),
    ...(value.error === undefined ? {} : { error: value.error })
  }
}

function validSpan(value: unknown): value is TraceSpan {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.traceId !== 'string' ||
    !value.traceId ||
    typeof value.spanId !== 'string' ||
    !value.spanId ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    !['agent', 'model', 'tool', 'compaction'].includes(value.kind as string) ||
    typeof value.name !== 'string' ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !isCount(value.startedAt) ||
    !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status as string)
  )
    return false
  if (value.parentSpanId !== undefined && typeof value.parentSpanId !== 'string') return false
  if (value.model !== undefined && typeof value.model !== 'string') return false
  if (value.toolCallId !== undefined && typeof value.toolCallId !== 'string') return false
  if (value.detached !== undefined && typeof value.detached !== 'boolean') return false
  if (value.endedAt !== undefined && (!isCount(value.endedAt) || value.endedAt < value.startedAt)) return false
  if (value.ttftMs !== undefined && !isCount(value.ttftMs)) return false
  if (
    value.error !== undefined &&
    !['context_overflow', 'provider_error', 'tool_error', 'compaction_error', 'agent_error'].includes(
      value.error as string
    )
  )
    return false
  if (value.usage !== undefined) {
    if (!isRecord(value.usage) || !['provider', 'estimate'].includes(value.usage.source as string)) return false
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
      if (value.usage[key] !== undefined && !isCount(value.usage[key])) return false
  }
  if (
    value.cost !== undefined &&
    (!isRecord(value.cost) ||
      typeof value.cost.currency !== 'string' ||
      !value.cost.currency ||
      !isCount(value.cost.amount) ||
      !['provider', 'estimate'].includes(value.cost.source as string))
  )
    return false
  return true
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
