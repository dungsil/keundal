import type { AGUIEvent, GenerationRequest, GenerationSnapshot, RunAgentInput, SessionSnapshot } from '@keundal/core'
import { EventType } from '@keundal/core'

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
  const collected = collect(
    store.generation.run(request('r-cancel'), {
      signal: controller.signal,
      stream: async function* (_request, options) {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
        const halted = Promise.withResolvers<void>()
        options.signal.addEventListener('abort', () => halted.reject(options.signal.reason), { once: true })
        await halted.promise
      }
    })
  )
  collected.catch(() => {})
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20))
  controller.abort(new Error('client went away'))
  // 스트림이 끝난 뒤에도 취소 확정 커밋이 비동기로 진행될 수 있으므로 기다립니다.
  await collected.catch(() => {})
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

const scenarios: ReadonlyArray<{ name: string; run: (store: ConformanceStore) => Promise<unknown> }> = [
  { name: 'success', run: successScenario },
  { name: 'failedPartial', run: failedPartialScenario },
  { name: 'cancelled', run: cancelledScenario },
  { name: 'firstTerminalCommit', run: firstTerminalCommitScenario },
  { name: 'prepareMerge', run: prepareMergeScenario },
  { name: 'duplicateTerminalCommit', run: duplicateTerminalScenario },
  { name: 'listReads', run: listScenario }
]

/** 세 저장소가 같은 결과를 내야 하는 시나리오의 기대 보고서입니다. */
export const expectedConformanceReport: ConformanceReport = {
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
