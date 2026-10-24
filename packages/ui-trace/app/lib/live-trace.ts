import { EventType, TRACE_EVENT, readTraceSpans } from '@keundal/core'
import type { AGUIEvent, TraceSpan } from '@keundal/core'
import { shallowReactive } from 'vue'
import type { ChatIndicatorOwner } from '@keundal/ui-chat/slots'

type Messages = ChatIndicatorOwner['messages']

/** Assistant responses that offer a trace panel: the latest ones. */
export const TRACE_PANEL_LIMIT = 20

/** Spans kept per conversation while a run streams. */
export const MAX_LIVE_SPANS = 200

/** Live trace of one conversation: the run being observed and the spans of its agent trace. */
export interface LiveTrace {
  /** Run whose trace is being followed. It stays set after the run finishes. */
  activeRunId: string | undefined
  /** Trace that the active run's agent span belongs to; spans of other traces are ignored. */
  activeTraceId: string | undefined
  /** Latest state of every span, oldest first. Replaced on every update. */
  spans: ReadonlyMap<string, TraceSpan>
}

export function createLiveTrace(): LiveTrace {
  return shallowReactive<LiveTrace>({ activeRunId: undefined, activeTraceId: undefined, spans: new Map() })
}

/** Follow one run event: a new run resets the trace, and trace events of the active run's trace update it. */
export function applyLiveTraceEvent(trace: LiveTrace, event: AGUIEvent): void {
  if (event.type === EventType.RUN_STARTED) {
    trace.activeRunId = event.runId
    trace.activeTraceId = undefined
    trace.spans = new Map()
  } else if (event.type === EventType.CUSTOM && event.name === TRACE_EVENT) {
    const span = readTraceSpans([event], undefined, 1)[0]
    if (!span) return
    if (span.runId === trace.activeRunId && span.kind === 'agent') trace.activeTraceId = span.traceId
    if (span.traceId !== trace.activeTraceId) return
    const updated = new Map(trace.spans)
    updated.delete(span.spanId)
    updated.set(span.spanId, span)
    while (updated.size > MAX_LIVE_SPANS) updated.delete(updated.keys().next().value!)
    trace.spans = updated
  }
}

/** The root panel stands in for the response until the active run's assistant message has content. */
export function showRootTrace(trace: LiveTrace, messages: Messages): boolean {
  return !!trace.activeRunId && !messages.some(message => message.role === 'assistant' && message.id === trace.activeRunId && message.parts.length > 0)
}

/** Ids of the assistant messages that offer a trace panel. A response's id is the run id. */
export function traceRunIds(messages: Messages): Set<string> {
  return new Set(messages.filter(message => message.role === 'assistant').slice(-TRACE_PANEL_LIMIT).map(message => message.id))
}
