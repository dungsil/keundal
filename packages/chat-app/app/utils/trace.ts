import type { GenerationStatus, TraceSpan, TraceUsage } from '@keundal/core'

export interface TraceRow {
  span: TraceSpan
  depth: number
}

export function flattenTraceSpans(spans: readonly TraceSpan[], maxRows: number): TraceRow[] {
  const byId = new Map<string, TraceSpan>()
  const children = new Map<string | undefined, TraceSpan[]>()
  const ordered = [...spans].sort((a, b) => a.runId === b.runId ? a.sequence - b.sequence || a.startedAt - b.startedAt : a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId))
  for (const span of ordered) byId.set(span.spanId, span)
  for (const span of ordered) {
    const parentId = span.parentSpanId && byId.has(span.parentSpanId) ? span.parentSpanId : undefined
    const siblings = children.get(parentId) ?? []
    siblings.push(span)
    children.set(parentId, siblings)
  }
  const rows: TraceRow[] = []
  const stack = [...(children.get(undefined) ?? [])].reverse().map(span => ({ span, depth: 0 }))
  const visited = new Set<string>()
  while (stack.length > 0 && rows.length < maxRows) {
    const row = stack.pop()!
    if (visited.has(row.span.spanId)) continue
    visited.add(row.span.spanId)
    rows.push(row)
    const descendants = children.get(row.span.spanId) ?? []
    for (let index = descendants.length - 1; index >= 0; index--) {
      stack.push({ span: descendants[index]!, depth: row.depth + 1 })
    }
  }
  return rows
}
export function reconcileTraceSpans(spans: readonly TraceSpan[], runStatus: GenerationStatus, runId?: string): TraceSpan[] {
  if (runStatus === 'running') return [...spans]
  const ids = new Set(spans.map(span => span.spanId))
  const root = spans.find(span => span.kind === 'agent' && (runId === undefined || span.runId === runId) && (!span.parentSpanId || !ids.has(span.parentSpanId)))
  return spans.map(span => {
    if (span === root && (runStatus === 'failed' || runStatus === 'interrupted')) return { ...span, status: runStatus }
    if (span.status !== 'running' || (span.detached && span.endedAt === undefined)) return span
    return { ...span, status: runStatus }
  })
}

export function traceDisplayStatus(span: TraceSpan, runStatus: GenerationStatus): TraceSpan['status'] | 'unknown' {
  return span.detached && span.endedAt === undefined && runStatus !== 'running' ? 'unknown' : span.status
}

export function traceTimelineBounds(spans: readonly TraceSpan[], now: number, runStatus?: GenerationStatus): { start: number; end: number } {
  if (!spans.length) return { start: 0, end: 0 }
  let start = spans[0]!.startedAt
  let end = start
  for (const span of spans) {
    start = Math.min(start, span.startedAt)
    const detachedUnknown = span.detached && span.endedAt === undefined && runStatus !== undefined && runStatus !== 'running'
    end = Math.max(end, span.endedAt ?? (span.status === 'running' && !detachedUnknown ? now : span.startedAt))
  }
  return { start, end: Math.max(start, end) }
}

export function traceUsageCompleteness(spans: readonly TraceSpan[]) {
  const models = [...new Map(spans.filter(span => span.kind === 'model').map(span => [span.spanId, span])).values()]
  const complete = (field: keyof Omit<TraceUsage, 'source'>) => models.length > 0 && models.every(span => span.status !== 'running' && span.usage?.[field] !== undefined)
  return {
    inputTokens: complete('inputTokens'),
    outputTokens: complete('outputTokens'),
    cacheReadTokens: complete('cacheReadTokens'),
    cacheWriteTokens: complete('cacheWriteTokens')
  }
}

export function traceRunDuration(spans: readonly TraceSpan[], status: GenerationStatus, now: number, runId?: string): number | undefined {
  const ids = new Set(spans.map(span => span.spanId))
  const root = spans.find(span => span.kind === 'agent' && (runId === undefined || span.runId === runId) && (!span.parentSpanId || !ids.has(span.parentSpanId)))
  if (!root) return undefined
  const end = root.endedAt ?? (status === 'running' ? now : undefined)
  return end === undefined ? undefined : Math.max(0, end - root.startedAt)
}
