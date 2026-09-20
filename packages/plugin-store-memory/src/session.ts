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

import type { MemoryStore, StoredThread } from './store.js'

function snapshot(threadId: string, thread: StoredThread): SessionSnapshot {
  return { threadId, revision: thread.revision, messages: [...thread.messages], state: thread.state }
}

/**
 * 스레드 대화와 상태를 메모리에 보관합니다. prepare는 저장된 대화를 요청 메시지 앞에 병합하고,
 * commit은 기준 revision과 실행 종료 기록을 하나의 단위로 확정합니다.
 */
export class MemorySessionService extends SessionService {
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: MemoryStore
  ) {
    super(ctx)
    ctx.fiber.effect(() => () => {
      this.closed = true
    })
  }

  async get(threadId: string, options?: ExecutionOptions): Promise<SessionSnapshot | undefined> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const thread = this.store.threads.get(threadId)
    return thread ? snapshot(threadId, thread) : undefined
  }

  async list(options?: ExecutionOptions): Promise<SessionSnapshot[]> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    return [...this.store.threads.entries()].map(([threadId, thread]) => snapshot(threadId, thread))
  }

  async prepare(input: RunAgentInput, options?: ExecutionOptions): Promise<PreparedSession> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const request = parseRunAgentInput(input)
    const thread = this.store.threads.get(request.threadId)
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

    const current = this.store.threads.get(change.threadId) ?? { revision: 0, messages: [], state: undefined }

    const generation = change.generation
    const runId = generation?.request.input.runId
    if (generation) {
      if (!runId) throw new Error('generation commit requires a runId')
      if (generation.request.input.threadId !== change.threadId)
        throw new Error(`generation ${runId} belongs to another thread: ${generation.request.input.threadId}`)
      const stored = this.store.runs.get(runId)
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

    const next: StoredThread = {
      revision: current.revision + 1,
      messages: mergeMessages(current.messages, change.messages),
      state: change.state ?? current.state
    }
    this.store.threads.set(change.threadId, next)
    if (generation && runId) {
      this.store.runs.set(runId, {
        runId,
        threadId: change.threadId,
        request: generation.request,
        status: generation.status,
        journal: [...generation.journal],
        messages: [...generation.messages],
        lease: { active: false }
      })
    }
    return snapshot(change.threadId, next)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('memory session service disposed')
  }
}
