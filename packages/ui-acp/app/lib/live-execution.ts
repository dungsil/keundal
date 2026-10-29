import { EventType, type AGUIEvent } from '@keundal/core'
import type { GenerationSnapshot } from '@keundal/generation'
import { reactive } from 'vue'
import { applyExecutionEvent, createExecution, type AcpExecution } from './execution'

export function createLiveExecution() {
  return reactive({
    activeRunId: undefined as string | undefined,
    runs: new Map<string, AcpExecution>(),
    events: new Map<string, AGUIEvent[]>()
  })
}
export type LiveExecution = ReturnType<typeof createLiveExecution>

function isExecutionEvent(event: AGUIEvent) {
  return event.type === EventType.RUN_STARTED || event.type === EventType.RUN_FINISHED ||
    event.type === EventType.RUN_ERROR || event.type === EventType.TOOL_CALL_START ||
    (event.type === EventType.CUSTOM && event.name === 'keundal.acp.update')
}

export function applyLiveExecutionEvent(live: LiveExecution, event: AGUIEvent) {
  if (event.type === EventType.RUN_STARTED) live.activeRunId = event.runId
  const id = live.activeRunId
  if (!id) return
  // Text content already belongs to the transcript. Only retain execution data.
  if (!isExecutionEvent(event)) return
  const events = live.events.get(id) ?? []
  events.push(event)
  live.events.set(id, events)
  if (!live.runs.has(id)) live.runs.set(id, createExecution())
  applyExecutionEvent(live.runs.get(id)!, event)
}

/** A running SQLite snapshot may lag events delivered before the read began. */
export function restoreExecution(live: LiveExecution, id: string, snapshot: GenerationSnapshot) {
  const state = createExecution()
  for (const { event } of snapshot.journal) applyExecutionEvent(state, event)
  if (snapshot.status === 'running') {
    const events = live.events.get(id) ?? []
    const persisted = snapshot.journal.map(({ event }) => event).filter(isExecutionEvent)
    let shared = 0
    while (shared < events.length && shared < persisted.length &&
      JSON.stringify(events[shared]) === JSON.stringify(persisted[shared])) shared++
    // Replay only the live tail: a newer snapshot must not be rolled back by
    // an older plan or tool update already represented in its journal.
    for (const event of events.slice(shared)) applyExecutionEvent(state, event)
    // The live projection has the authoritative translated ID for buffered tools.
    for (const [key, tool] of live.runs.get(id)?.tools ?? []) {
      if (tool.aguiToolCallId && state.tools.has(key)) state.tools.get(key)!.aguiToolCallId = tool.aguiToolCallId
    }
  } else {
    state.status = snapshot.status
    live.events.delete(id)
  }
  live.runs.set(id, state)
}
