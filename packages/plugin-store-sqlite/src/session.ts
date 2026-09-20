import {
  mergeMessages,
  parseRunAgentInput,
  SessionService,
  type ExecutionOptions,
  type PreparedSession,
  type RunAgentInput,
  type SessionCommit,
  type SessionSnapshot
} from '@keundal/core'
import type { Context } from 'cordis'

import type { SqliteStore, StoredThread } from './store.js'

const snapshot = (threadId: string, thread: StoredThread): SessionSnapshot => ({
  threadId,
  revision: thread.revision,
  messages: thread.messages,
  state: thread.state
})

/**
 * 스레드 대화와 상태를 SQLite 저장소에 보관합니다. prepare는 저장된 대화를 요청 메시지 앞에
 * 병합하고, commit은 기준 revision과 실행 종료 기록을 하나의 트랜잭션으로 확정합니다.
 */
export class SqliteSessionService extends SessionService {
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: SqliteStore
  ) {
    super(ctx)
    store.retain()
    ctx.fiber.effect(() => () => {
      this.closed = true
      this.store.release()
    })
  }

  async get(threadId: string, options?: ExecutionOptions): Promise<SessionSnapshot | undefined> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const thread = this.store.readThread(threadId)
    return thread && snapshot(threadId, thread)
  }

  async list(options?: ExecutionOptions): Promise<SessionSnapshot[]> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    return this.store.listThreads().map(({ threadId, revision, messages, state }) => ({
      threadId,
      revision,
      messages,
      state
    }))
  }

  async prepare(input: RunAgentInput, options?: ExecutionOptions): Promise<PreparedSession> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const request = parseRunAgentInput(input)
    const thread = this.store.readThread(request.threadId)
    return {
      input: {
        ...request,
        messages: mergeMessages(thread?.messages ?? [], request.messages),
        state: request.state ?? thread?.state
      },
      revision: thread?.revision ?? 0
    }
  }

  async commit(change: SessionCommit, options?: ExecutionOptions): Promise<SessionSnapshot> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    if (typeof change.threadId !== 'string' || !change.threadId.trim())
      throw new Error('commit requires a non-empty threadId')
    if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0)
      throw new Error('commit requires a non-negative expectedRevision')
    const generation = change.generation
    if (generation) {
      const runId = generation.request.input.runId
      if (!runId) throw new Error('generation commit requires a runId')
      if (generation.request.input.threadId !== change.threadId)
        throw new Error(`generation ${runId} belongs to another thread: ${generation.request.input.threadId}`)
    }

    // DatabaseSync는 동기 API이므로 이 커밋은 반환된 Promise를 기다리지 않아도 저장됩니다.
    return this.store.transaction(() => {
      const current = this.store.readThread(change.threadId) ?? { revision: 0, messages: [], state: undefined }
      if (generation) {
        const runId = generation.request.input.runId
        const stored = this.store.readRunHeader(runId)
        if (stored && stored.threadId !== change.threadId)
          throw new Error(`generation ${runId} belongs to another thread: ${stored.threadId}`)
        // 이미 종료를 확정한 실행은 revision 검사보다 중복 적용 건너뛰기가 우선합니다. 종료 기록을
        // 적용한 뒤 결과 확인에 실패한 호출이 기준 revision을 몰라도 같은 commit을 다시 시도할 수
        // 있어야 하기 때문입니다. 기록이 없는 실행은 중복이 아니므로 첫 종료 기록을 확정합니다.
        if (stored && stored.status !== 'running') return snapshot(change.threadId, current)
      }

      if (current.revision !== change.expectedRevision) {
        throw new Error(
          `session revision conflict for ${change.threadId}: expected ${change.expectedRevision}, stored ${current.revision}`
        )
      }

      if (generation) {
        const runId = generation.request.input.runId
        // 시작 없이 도착한 종료 기록이 journal과 메시지를 받을 행을 가지도록 등록을 보장합니다.
        this.store.ensureRun(runId, change.threadId, generation.request, generation.status)
        this.store.writeJournal(runId, generation.journal)
        this.store.writeRunMessages(runId, generation.messages)
        this.store.finishRun(runId, generation.status)
      }
      const next: StoredThread = {
        revision: current.revision + 1,
        messages: mergeMessages(current.messages, change.messages),
        state: change.state ?? current.state
      }
      this.store.writeThread(change.threadId, next.revision, next.state)
      this.store.writeThreadMessages(change.threadId, change.messages)
      return snapshot(change.threadId, next)
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite session service disposed')
  }
}
