import type { AGUIEvent, RunAgentInput } from '@keundal/core'
import { CONTEXT_MESSAGE_EVENT, EventType, MessageAssembly } from '@keundal/core'
import type { GenerationRequest, GenerationSnapshot } from '@keundal/generation'
import type { SessionSnapshot } from '@keundal/session'

export type { AGUIEvent, GenerationRequest, GenerationSnapshot, RunAgentInput, SessionSnapshot }

/**
 * 적합성 시나리오가 요구하는 최소 저장소 표면입니다. 세 공식 저장소의 서비스가 구조적으로 이
 * 모양을 만족합니다. 실행은 scripted stream 공급자를 run()에 직접 전달해 구동합니다.
 */
export interface ConformanceStore {
  session: {
    prepare(input: RunAgentInput): Promise<{ input: RunAgentInput; revision: number }>
    commit(change: {
      threadId: string
      expectedRevision: number
      mode?: 'merge' | 'replace'
      messages: RunAgentInput['messages']
      state?: RunAgentInput['state']
      metadata?: Record<string, unknown>
      generation?: unknown
    }): Promise<{ threadId: string; revision: number; messages: RunAgentInput['messages'] }>
    get(threadId: string): Promise<SessionSnapshot | undefined>
    list(): Promise<SessionSnapshot[]>
  }
  generation: {
    run(
      request: GenerationRequest,
      options?: {
        signal?: AbortSignal
        stream?: (request: GenerationRequest, options: { signal: AbortSignal }) => AsyncIterable<AGUIEvent>
      }
    ): AsyncIterable<AGUIEvent>
    get(runId: string): Promise<GenerationSnapshot | undefined>
    list(): Promise<GenerationSnapshot[]>
    recover(): Promise<GenerationSnapshot[]>
    subscribe(
      runId: string,
      options?: { afterSequence?: number; signal?: AbortSignal }
    ): AsyncIterable<{ sequence: number; event: AGUIEvent }>
  }
  backup: {
    export(): Promise<{ threads: SessionSnapshot[]; runs: GenerationSnapshot[] }>
    import(data: { threads: SessionSnapshot[]; runs: GenerationSnapshot[] }): Promise<void>
  }
  disposeAll(): Promise<void>
}

export interface ScenarioResult {
  scenario: string
  detail: unknown
}

export type ConformanceReport = Record<string, unknown>

const collect = async (stream: AsyncIterable<AGUIEvent>): Promise<AGUIEvent[]> => {
  const out: AGUIEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

const text = (delta: string): AGUIEvent => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta })

const journalTypes = (snapshot: GenerationSnapshot | undefined): string[] =>
  snapshot?.journal.map((entry) => entry.event.type) ?? []

const messageIds = (messages: ReadonlyArray<{ id: string }>): string[] => messages.map((message) => message.id)

const defaultStream = async function* (): AsyncIterable<AGUIEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
  yield text('hello')
  yield { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
}

const request = (runId: string, revision = 0): GenerationRequest => ({
  input: {
    threadId: 'thread',
    runId,
    state: { step: 1 },
    messages: [{ id: 'question', role: 'user', content: 'question' }],
    tools: [],
    context: []
  },
  model: 'test-model',
  maxOutputTokens: 20,
  sessionRevision: revision
})

/** 실행이 종료 상태로 확정될 때까지 짧게 기다립니다. 취소 확정은 비동기 경로에 있습니다. */
const waitForTerminal = async (
  store: ConformanceStore,
  runId: string,
  timeoutMs = 5_000
): Promise<GenerationSnapshot | undefined> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = await store.generation.get(runId)
    if (run && run.status !== 'running') return run
    if (Date.now() > deadline) return run
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
  }
}

const successScenario = async (store: ConformanceStore): Promise<unknown> => {
  const events = await collect(store.generation.run(request('r1'), { stream: defaultStream }))
  const run = await store.generation.get('r1')
  const thread = await store.session.get('thread')
  const runs = await store.generation.list()
  return {
    eventTypes: events.map((event) => event.type),
    runStatus: run?.status,
    runJournal: journalTypes(run),
    runMessageIds: messageIds(run?.messages ?? []),
    threadRevision: thread?.revision,
    threadMessageIds: messageIds(thread?.messages ?? []),
    runListStatuses: runs.map((snapshot) => snapshot.status)
  }
}

const failedPartialScenario = async (store: ConformanceStore): Promise<unknown> => {
  let error = ''
  try {
    await collect(
      store.generation.run(request('r-fail'), {
        stream: async function* () {
          yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
          yield text('hel')
          throw new Error('llm boom')
        }
      })
    )
  } catch (e) {
    error = String((e as Error)?.message ?? e)
  }
  const run = await store.generation.get('r-fail')
  return {
    error,
    status: run?.status,
    journal: journalTypes(run),
    messageIds: messageIds(run?.messages ?? []),
    threadRevision: (await store.session.get('thread'))?.revision
  }
}

const cancelledScenario = async (store: ConformanceStore): Promise<unknown> => {
  const controller = new globalThis.AbortController()
  const events = store.generation.run(request('r-cancel'), {
    signal: controller.signal,
    stream: async function* (_request, options) {
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
      const halted = Promise.withResolvers<void>()
      if (options.signal.aborted) halted.reject(options.signal.reason)
      else options.signal.addEventListener('abort', () => halted.reject(options.signal.reason), { once: true })
      await halted.promise
    }
  })
  try {
    for await (const event of events) {
      // 부분 응답이 소비자에게 전달된 뒤 취소해야 저장소 속도와 무관하게 같은 journal을 검증할 수 있습니다.
      if (event.type === EventType.TEXT_MESSAGE_START) controller.abort(new Error('client went away'))
    }
  } catch {
    // 취소된 실행은 순회 중 예외로 끝납니다.
  }
  // 스트림이 끝난 뒤에도 취소 확정 커밋이 비동기로 진행될 수 있으므로 기다립니다.
  const run = await waitForTerminal(store, 'r-cancel')
  return { status: run?.status, journal: journalTypes(run) }
}

const firstTerminalCommitScenario = async (store: ConformanceStore): Promise<unknown> => {
  const imported = request('imported')
  const messages = [{ id: 'reply', role: 'assistant' as const, content: 'hello' }]
  const journal = [
    { sequence: 0, event: { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'imported' } },
    {
      sequence: 1,
      event: { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'imported', outcome: { type: 'success' } }
    }
  ]
  await store.session.commit({
    threadId: 'thread',
    expectedRevision: 0,
    messages,
    state: undefined,
    generation: { request: imported, status: 'completed', journal, messages }
  })
  const run = await store.generation.get('imported')
  const thread = await store.session.get('thread')
  return {
    revision: thread?.revision,
    threadMessageIds: messageIds(thread?.messages ?? []),
    runStatus: run?.status,
    runJournal: journalTypes(run)
  }
}

const prepareMergeScenario = async (store: ConformanceStore): Promise<unknown> => {
  await collect(store.generation.run(request('r-merge'), { stream: defaultStream }))
  const prepared = await store.session.prepare({
    threadId: 'thread',
    runId: 'r-next',
    state: undefined,
    tools: [],
    context: [],
    messages: [
      { id: 'reply', role: 'assistant', content: 'replaced' },
      { id: 'q2', role: 'user', content: 'new' }
    ]
  })
  return { revision: prepared.revision, messageIds: messageIds(prepared.input.messages) }
}

const duplicateTerminalScenario = async (store: ConformanceStore): Promise<unknown> => {
  await collect(store.generation.run(request('r-dup'), { stream: defaultStream }))
  const run = await store.generation.get('r-dup')
  const stored = await store.session.get('thread')
  const repeated = await store.session.commit({
    threadId: 'thread',
    expectedRevision: 0,
    messages: run?.messages ?? [],
    state: stored?.state,
    generation: {
      request: run?.request,
      status: 'completed',
      journal: run?.journal ?? [],
      messages: run?.messages ?? []
    }
  })
  return { revision: repeated.revision, threadRevision: (await store.session.get('thread'))?.revision }
}

const streamScenario = async (store: ConformanceStore): Promise<unknown> => {
  const gate = Promise.withResolvers<void>()
  const first = Promise.withResolvers<void>()
  const sequences: number[] = []
  const types: string[] = []
  let streamCalls = 0
  const run = store.generation.run(request('r-stream'), {
    stream: async function* () {
      streamCalls++
      yield text('one')
      first.resolve()
      await gate.promise
      yield text('two')
    }
  })
  const pump = (async () => {
    for await (const _event of run) {
      /* 실행은 소비자와 분리해 끝까지 진행합니다. */
    }
  })()
  await first.promise
  // 실행 중에 구독을 붙이면 지난 기록을 재생한 뒤 실시간 기록을 이어서 받습니다.
  for await (const entry of store.generation.subscribe('r-stream', { afterSequence: -1 })) {
    sequences.push(entry.sequence)
    types.push(entry.event.type)
    if (types.length === 2) gate.resolve()
  }
  await pump
  const replay: number[] = []
  for await (const entry of store.generation.subscribe('r-stream', { afterSequence: 1 })) replay.push(entry.sequence)
  return {
    sequences,
    types,
    replay,
    streamCalls,
    status: (await store.generation.get('r-stream'))?.status
  }
}

const streamFailureScenario = async (store: ConformanceStore): Promise<unknown> => {
  const types: string[] = []
  const started = Promise.withResolvers<void>()
  let error = ''
  const run = store.generation.run(request('r-stream-fail'), {
    stream: async function* () {
      yield text('partial')
      throw new Error('stream boom')
    }
  })
  const pump = (async () => {
    let received = 0
    try {
      for await (const _event of run) {
        if (received++ === 0) started.resolve()
      }
    } catch (cause) {
      error = String((cause as Error)?.message ?? cause)
    }
  })()
  await started.promise
  for await (const entry of store.generation.subscribe('r-stream-fail', { afterSequence: -1 })) {
    types.push(entry.event.type)
  }
  await pump
  return { types, error, status: (await store.generation.get('r-stream-fail'))?.status }
}

const listScenario = async (store: ConformanceStore): Promise<unknown> => {
  await collect(store.generation.run(request('z-run'), { stream: defaultStream }))
  const sessions = await store.session.list()
  const runs = await store.generation.list()
  return {
    threadIds: sessions.map((snapshot) => snapshot.threadId).sort(),
    runIds: runs.map((snapshot) => snapshot.request.input.runId).sort(),
    runStatuses: runs.map((snapshot) => snapshot.status).sort()
  }
}

const contextScenario = async (store: ConformanceStore): Promise<unknown> => {
  const initial = { id: 'keundal:context:instructions:initial', role: 'user', content: 'Use tabs.' }
  const changed = { id: 'keundal:context:instructions:changed', role: 'user', content: 'Use spaces.' }
  await collect(
    store.generation.run(request('context-run'), {
      stream: async function* () {
        yield { type: EventType.CUSTOM, name: CONTEXT_MESSAGE_EVENT, value: initial }
        yield { type: EventType.CUSTOM, name: CONTEXT_MESSAGE_EVENT, value: changed }
        yield* defaultStream()
      }
    })
  )
  const run = await store.generation.get('context-run')
  const thread = await store.session.get('thread')
  const prepared = await store.session.prepare({ ...request('context-next', 1).input, messages: [] })
  return {
    run: run?.messages.slice(0, 2),
    stored: thread?.messages.slice(0, 2),
    resumed: prepared.input.messages.slice(0, 2)
  }
}

const messageCollisionScenario = async (store: ConformanceStore): Promise<unknown> => {
  const original = [
    { id: 'victim-user', role: 'user' as const, content: 'trusted question' },
    { id: 'victim-assistant', role: 'assistant' as const, content: 'trusted answer' }
  ]
  await store.session.commit({ threadId: 'thread', expectedRevision: 0, messages: original })
  const rejected: boolean[] = []
  for (const mode of ['merge', 'replace'] as const) {
    for (const victim of original) {
      const messages = [{ id: victim.id, role: 'assistant' as const, content: 'overwrite' }]
      const run = request(`${mode}-${victim.id}`, 1)
      try {
        await store.session.commit({
          threadId: 'thread',
          expectedRevision: 1,
          mode,
          messages,
          generation: { request: run, status: 'completed', journal: [], messages }
        })
        rejected.push(false)
      } catch (error) {
        rejected.push(String(error).includes('generation message conflicts with committed history'))
      }
    }
  }
  const afterRejected = await store.session.get('thread')
  const noRunsWritten = (await store.generation.list()).length === 0
  const triggers: AGUIEvent[] = [
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'victim-user', delta: 'overwrite' },
    { type: EventType.REASONING_MESSAGE_START, messageId: 'victim-assistant', role: 'reasoning' },
    { type: EventType.TOOL_CALL_START, toolCallId: 'victim-user', toolCallName: 'lookup' },
    { type: EventType.TOOL_CALL_RESULT, messageId: 'victim-assistant', toolCallId: 'call', content: 'overwrite' }
  ]
  const failed: boolean[] = []
  for (const [index, trigger] of triggers.entries()) {
    const revision = (await store.session.get('thread'))!.revision
    const run = request(`collision-${index}`, revision)
    const events: AGUIEvent[] = []
    try {
      for await (const event of store.generation.run(run, {
        stream: async function* () {
          yield trigger
        }
      }))
        events.push(event)
      failed.push(false)
    } catch (error) {
      const terminal = await store.generation.get(run.input.runId)
      failed.push(
        String(error).includes('generation message conflicts with committed history') &&
          (terminal?.status === 'failed' || terminal?.status === 'interrupted') &&
          terminal.messages[0]?.id === original[index % 2].id &&
          !events.some((event) => event.type === EventType.RUN_FINISHED)
      )
    }
  }
  const historyPreserved = JSON.stringify((await store.session.get('thread'))?.messages) === JSON.stringify(original)
  const revision = (await store.session.get('thread'))!.revision
  await store.session.commit({
    threadId: 'thread',
    expectedRevision: revision,
    messages: [{ ...original[0], content: 'authorized edit' }]
  })
  return {
    rejected,
    rejectionWasAtomic:
      afterRejected?.revision === 1 &&
      JSON.stringify(afterRejected.messages) === JSON.stringify(original) &&
      noRunsWritten,
    failed,
    historyPreserved,
    editingPreserved: (await store.session.get('thread'))?.messages[0].content === 'authorized edit'
  }
}

async function chunkScenario(store: ConformanceStore): Promise<unknown> {
  const events = await collect(
    store.generation.run(request('chunks'), {
      stream: async function* () {
        yield {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: 'policy',
          role: 'developer',
          delta: 'Policy',
          metadata: { keep: true }
        }
        yield { type: EventType.REASONING_MESSAGE_CHUNK, messageId: 'reason', delta: 'Check' }
        yield { type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'reply', delta: 'All ' }
        yield { type: EventType.TEXT_MESSAGE_CHUNK, delta: 'done', metadata: { done: true } }
      }
    })
  )
  const run = await store.generation.get('chunks')
  const session = await store.session.get('thread')
  return {
    eventTypes: events.map((event) => event.type),
    messages: run?.messages,
    sessionMessages: session?.messages,
    replayMatches:
      JSON.stringify(await Array.fromAsync(store.generation.subscribe('chunks'))) === JSON.stringify(run?.journal)
  }
}

async function stateSeedScenario(store: ConformanceStore): Promise<unknown> {
  const states: unknown[] = [{ step: 1 }, undefined, null, false]
  const snapshots: unknown[] = []
  for (const [index, state] of states.entries()) {
    const run = request(`state-seed-${index}`)
    run.input.threadId = `state-thread-${index}`
    run.input.state = state
    await collect(
      store.generation.run(run, {
        stream: async function* () {
          if (index === 0) yield { type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/step', value: 2 }] }
        }
      })
    )
    snapshots.push((await store.generation.get(run.input.runId))?.state)
  }
  return {
    snapshots,
    listed: (await store.generation.list()).map((run) => run.state),
    recovered: (await store.generation.recover()).map((run) => run.state),
    committed: (await store.session.list()).map((session) => session.state),
    original: states[0]
  }
}

async function stateActivityScenario(store: ConformanceStore): Promise<unknown> {
  let streamCalls = 0
  const runRequest = request('state-activity')
  const activity = (messageId: string, content: Record<string, unknown>, replace = true): AGUIEvent => ({
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId,
    activityType: 'progress',
    content,
    replace
  })
  await collect(
    store.generation.run(runRequest, {
      stream: async function* () {
        streamCalls++
        yield { type: EventType.STATE_SNAPSHOT, snapshot: { items: [], phase: 'snapshot' } }
        yield { type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/items/-', value: 'first' }] }
        yield {
          type: EventType.STATE_DELTA,
          delta: [
            { op: 'replace', path: '/items/0', value: 'updated' },
            { op: 'add', path: '/items/-', value: 'second' }
          ]
        }
        yield {
          type: EventType.STATE_DELTA,
          delta: [
            { op: 'replace', path: '/phase', value: 'must not survive' },
            { op: 'remove', path: '/missing' }
          ]
        }
        yield activity('activity-a', { step: 0, obsolete: true })
        yield activity('activity-b', { step: 10 })
        yield activity('activity-a', { step: 1 })
        yield activity('activity-a', { step: 99 }, false)
        yield {
          type: EventType.ACTIVITY_DELTA,
          messageId: 'activity-a',
          activityType: 'progress',
          patch: [{ op: 'replace', path: '/step', value: 2 }]
        }
        yield {
          type: EventType.ACTIVITY_DELTA,
          messageId: 'activity-a',
          activityType: 'progress',
          patch: [
            { op: 'replace', path: '/step', value: 99 },
            { op: 'remove', path: '/missing' }
          ]
        }
        yield {
          type: EventType.ACTIVITY_DELTA,
          messageId: 'missing-activity',
          activityType: 'progress',
          patch: [{ op: 'add', path: '/step', value: 99 }]
        }
      }
    })
  )
  const run = await store.generation.get(runRequest.input.runId)
  const session = await store.session.get('thread')
  const listed = (await store.generation.list())[0]
  const recovered = (await store.generation.recover())[0]
  const replay = new MessageAssembly(runRequest.input.state)
  const entries = await Array.fromAsync(store.generation.subscribe(runRequest.input.runId))
  for (const entry of entries) replay.apply(entry.event)
  return {
    state: run?.state,
    activities: run?.messages.map(({ id, role, content }) => ({ id, role, content })),
    sessionState: session?.state,
    sessionMessagesMatch: JSON.stringify(session?.messages) === JSON.stringify(run?.messages),
    listedState: listed?.state,
    recoveredState: recovered?.state,
    recoveredMessagesMatch: JSON.stringify(recovered?.messages) === JSON.stringify(run?.messages),
    replayState: replay.state,
    replayMessagesMatch: JSON.stringify(replay.messages) === JSON.stringify(run?.messages),
    journalMatches: JSON.stringify(entries) === JSON.stringify(run?.journal),
    warningCount: replay.warnings.length,
    streamCalls
  }
}

async function partialStateScenario(store: ConformanceStore, fail: boolean): Promise<unknown> {
  await store.session.commit({ threadId: 'thread', expectedRevision: 0, messages: [], state: { committed: true } })
  let streamCalls = 0
  let error = ''
  const runRequest = request(fail ? 'state-failed' : 'state-interrupted', 1)
  try {
    for await (const event of store.generation.run(runRequest, {
      stream: async function* () {
        streamCalls++
        yield { type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/step', value: 2 }] }
        yield {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: 'partial-activity',
          activityType: 'progress',
          content: { partial: true }
        }
        if (fail) throw new Error('state stream failed')
      }
    })) {
      if (!fail && event.type === EventType.ACTIVITY_SNAPSHOT) break
    }
  } catch (e) {
    error = (e as Error).message
  }
  const run = await store.generation.get(runRequest.input.runId)
  const recovered = (await store.generation.recover())[0]
  const replay = new MessageAssembly(runRequest.input.state)
  for await (const entry of store.generation.subscribe(runRequest.input.runId)) replay.apply(entry.event)
  return {
    status: run?.status,
    state: run?.state,
    recoveredState: recovered?.state,
    replayState: replay.state,
    messagesMatch: JSON.stringify(replay.messages) === JSON.stringify(run?.messages),
    activityIds: messageIds(run?.messages ?? []),
    sessionState: (await store.session.get('thread'))?.state,
    sessionMessageIds: messageIds((await store.session.get('thread'))?.messages ?? []),
    streamCalls,
    error
  }
}

async function malformedStateScenario(store: ConformanceStore): Promise<unknown> {
  let rejected = false
  try {
    await collect(
      store.generation.run(request('malformed-state'), {
        stream: async function* () {
          yield {
            type: EventType.STATE_DELTA,
            delta: [{ op: 'replace', path: 12, value: 2 }]
          } as unknown as AGUIEvent
        }
      })
    )
  } catch {
    rejected = true
  }
  const run = await store.generation.get('malformed-state')
  return { rejected, status: run?.status, state: run?.state, journal: journalTypes(run) }
}

async function metadataBackupScenario(
  store: ConformanceStore,
  make: () => Promise<ConformanceStore>
): Promise<unknown> {
  await store.session.commit({
    threadId: 'thread',
    expectedRevision: 0,
    messages: [],
    state: { step: 1 },
    metadata: { web: { title: 'saved' } }
  })
  const first = await store.session.prepare({ ...request('metadata-first').input, state: undefined })
  await collect(
    store.generation.run(
      { ...request('metadata-first', first.revision), input: first.input },
      {
        stream: async function* () {
          yield { type: EventType.STATE_SNAPSHOT, snapshot: null }
        }
      }
    )
  )
  const afterFirst = await store.session.get('thread')
  const next = await store.session.prepare({ ...request('metadata-next').input, state: undefined })
  await collect(
    store.generation.run(
      { ...request('metadata-next', next.revision), input: next.input },
      {
        stream: async function* () {
          yield { type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '', value: { step: 2 } }] }
        }
      }
    )
  )
  const explicitNull = await store.session.prepare({ ...request('metadata-null').input, state: null })
  const preserved = await store.session.get('thread')
  await store.session.commit({
    threadId: 'thread',
    expectedRevision: preserved!.revision,
    messages: [],
    state: undefined,
    metadata: { web: { title: 'updated' } }
  })
  const data = await store.backup.export()
  const target = await make()
  try {
    await target.backup.import(data)
    const restored = await target.session.get('thread')
    const restoredRuns = await target.generation.recover()
    return {
      initialBaseline: first.input.state,
      nullCommitted: afterFirst?.state === null,
      nullBaseline: next.input.state,
      explicitNull: explicitNull.input.state,
      metadataNotForwarded: !('metadata' in first.input) && !('metadata' in next.input),
      preservedMetadata: preserved?.metadata,
      state: restored?.state,
      metadata: restored?.metadata,
      listedMetadata: (await target.session.list())[0]?.metadata,
      runStates: restoredRuns.map((run) => run.state),
      roundtripMatches: JSON.stringify(await target.backup.export()) === JSON.stringify(data)
    }
  } finally {
    await target.disposeAll()
  }
}

const scenarios: ReadonlyArray<{
  name: string
  run: (store: ConformanceStore, make: () => Promise<ConformanceStore>) => Promise<unknown>
}> = [
  { name: 'malformedState', run: malformedStateScenario },
  { name: 'metadataBackup', run: metadataBackupScenario },
  { name: 'stateSeed', run: stateSeedScenario },
  { name: 'stateActivity', run: stateActivityScenario },
  { name: 'stateFailed', run: (store) => partialStateScenario(store, true) },
  { name: 'stateInterrupted', run: (store) => partialStateScenario(store, false) },
  { name: 'chunks', run: chunkScenario },
  { name: 'messageCollisions', run: messageCollisionScenario },
  { name: 'success', run: successScenario },
  { name: 'durableContext', run: contextScenario },
  { name: 'failedPartial', run: failedPartialScenario },
  { name: 'cancelled', run: cancelledScenario },
  { name: 'followStream', run: streamScenario },
  { name: 'followStreamFailure', run: streamFailureScenario },
  { name: 'firstTerminalCommit', run: firstTerminalCommitScenario },
  { name: 'prepareMerge', run: prepareMergeScenario },
  { name: 'duplicateTerminalCommit', run: duplicateTerminalScenario },
  { name: 'listReads', run: listScenario }
]

/** 세 저장소가 같은 결과를 내야 하는 시나리오의 기대 보고서입니다. */
export const expectedConformanceReport: ConformanceReport = {
  malformedState: { rejected: true, status: 'failed', state: { step: 1 }, journal: ['RUN_STARTED'] },
  metadataBackup: {
    initialBaseline: { step: 1 },
    nullCommitted: true,
    nullBaseline: null,
    explicitNull: null,
    metadataNotForwarded: true,
    preservedMetadata: { web: { title: 'saved' } },
    state: { step: 2 },
    metadata: { web: { title: 'updated' } },
    listedMetadata: { web: { title: 'updated' } },
    runStates: [null, { step: 2 }],
    roundtripMatches: true
  },
  stateSeed: {
    snapshots: [{ step: 2 }, {}, null, false],
    listed: [{ step: 2 }, {}, null, false],
    recovered: [{ step: 2 }, {}, null, false],
    committed: [{ step: 2 }, {}, null, false],
    original: { step: 1 }
  },
  stateActivity: {
    state: { items: ['updated', 'second'], phase: 'snapshot' },
    activities: [
      { id: 'activity-a', role: 'activity', content: { step: 2 } },
      { id: 'activity-b', role: 'activity', content: { step: 10 } }
    ],
    sessionState: { items: ['updated', 'second'], phase: 'snapshot' },
    sessionMessagesMatch: true,
    listedState: { items: ['updated', 'second'], phase: 'snapshot' },
    recoveredState: { items: ['updated', 'second'], phase: 'snapshot' },
    recoveredMessagesMatch: true,
    replayState: { items: ['updated', 'second'], phase: 'snapshot' },
    replayMessagesMatch: true,
    journalMatches: true,
    warningCount: 3,
    streamCalls: 1
  },
  stateFailed: {
    status: 'failed',
    state: { step: 2 },
    recoveredState: { step: 2 },
    replayState: { step: 2 },
    messagesMatch: true,
    activityIds: ['partial-activity'],
    sessionState: { committed: true },
    sessionMessageIds: [],
    streamCalls: 1,
    error: 'state stream failed'
  },
  stateInterrupted: {
    status: 'interrupted',
    state: { step: 2 },
    recoveredState: { step: 2 },
    replayState: { step: 2 },
    messagesMatch: true,
    activityIds: ['partial-activity'],
    sessionState: { committed: true },
    sessionMessageIds: [],
    streamCalls: 1,
    error: ''
  },
  chunks: {
    eventTypes: [
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED'
    ],
    messages: [
      { id: 'policy', role: 'developer', content: 'Policy', metadata: { keep: true } },
      { id: 'reason', role: 'reasoning', content: 'Check' },
      { id: 'reply', role: 'assistant', content: 'All done', metadata: { done: true } }
    ],
    sessionMessages: [
      { id: 'policy', role: 'developer', content: 'Policy', metadata: { keep: true } },
      { id: 'reason', role: 'reasoning', content: 'Check' },
      { id: 'reply', role: 'assistant', content: 'All done', metadata: { done: true } }
    ],
    replayMatches: true
  },
  messageCollisions: {
    rejected: [true, true, true, true],
    rejectionWasAtomic: true,
    failed: [true, true, true, true],
    historyPreserved: true,
    editingPreserved: true
  },
  durableContext: {
    run: [
      { id: 'keundal:context:instructions:initial', role: 'user', content: 'Use tabs.' },
      { id: 'keundal:context:instructions:changed', role: 'user', content: 'Use spaces.' }
    ],
    stored: [
      { id: 'keundal:context:instructions:initial', role: 'user', content: 'Use tabs.' },
      { id: 'keundal:context:instructions:changed', role: 'user', content: 'Use spaces.' }
    ],
    resumed: [
      { id: 'keundal:context:instructions:initial', role: 'user', content: 'Use tabs.' },
      { id: 'keundal:context:instructions:changed', role: 'user', content: 'Use spaces.' }
    ]
  },
  success: {
    eventTypes: ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED'],
    runStatus: 'completed',
    runJournal: ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED'],
    runMessageIds: ['reply'],
    threadRevision: 1,
    threadMessageIds: ['reply'],
    runListStatuses: ['completed']
  },
  failedPartial: {
    error: 'llm boom',
    status: 'failed',
    journal: ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT'],
    messageIds: ['reply'],
    threadRevision: 1
  },
  cancelled: {
    status: 'cancelled',
    journal: ['RUN_STARTED', 'TEXT_MESSAGE_START']
  },
  followStream: {
    sequences: [0, 1, 2, 3],
    types: ['RUN_STARTED', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT', 'RUN_FINISHED'],
    replay: [2, 3],
    streamCalls: 1,
    status: 'completed'
  },
  followStreamFailure: {
    types: ['RUN_STARTED', 'TEXT_MESSAGE_CONTENT'],
    error: 'stream boom',
    status: 'failed'
  },
  firstTerminalCommit: {
    revision: 1,
    threadMessageIds: ['reply'],
    runStatus: 'completed',
    runJournal: ['RUN_STARTED', 'RUN_FINISHED']
  },
  prepareMerge: { revision: 1, messageIds: ['reply', 'q2'] },
  duplicateTerminalCommit: { revision: 1, threadRevision: 1 },
  listReads: {
    threadIds: ['thread'],
    runIds: ['z-run'],
    runStatuses: ['completed']
  }
}

/** 저장소 하나를 모든 시나리오로 구동하고 시나리오별 결과를 돌려줍니다. */
export async function runStoreConformance(make: () => Promise<ConformanceStore>): Promise<ConformanceReport> {
  const report: ConformanceReport = {}
  for (const scenario of scenarios) {
    const store = await make()
    try {
      report[scenario.name] = await scenario.run(store, make)
    } catch (error) {
      report[scenario.name] = { conformanceError: String((error as Error)?.stack ?? error) }
    } finally {
      await store.disposeAll().catch(() => {})
    }
  }
  return report
}

export { checkConcurrentCommitProperties } from './properties.js'
