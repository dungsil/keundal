import type { AGUIEvent, GenerationRequest, GenerationSnapshot, RunAgentInput, SessionSnapshot } from '@keundal/core'
import { CONTEXT_MESSAGE_EVENT, EventType } from '@keundal/core'

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

const scenarios: ReadonlyArray<{ name: string; run: (store: ConformanceStore) => Promise<unknown> }> = [
  { name: 'messageCollisions', run: messageCollisionScenario },
  { name: 'success', run: successScenario },
  { name: 'durableContext', run: contextScenario },
  { name: 'failedPartial', run: failedPartialScenario },
  { name: 'cancelled', run: cancelledScenario },
  { name: 'firstTerminalCommit', run: firstTerminalCommitScenario },
  { name: 'prepareMerge', run: prepareMergeScenario },
  { name: 'duplicateTerminalCommit', run: duplicateTerminalScenario },
  { name: 'listReads', run: listScenario }
]

/** 세 저장소가 같은 결과를 내야 하는 시나리오의 기대 보고서입니다. */
export const expectedConformanceReport: ConformanceReport = {
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
      report[scenario.name] = await scenario.run(store)
    } catch (error) {
      report[scenario.name] = { conformanceError: String((error as Error)?.stack ?? error) }
    } finally {
      await store.disposeAll().catch(() => {})
    }
  }
  return report
}
