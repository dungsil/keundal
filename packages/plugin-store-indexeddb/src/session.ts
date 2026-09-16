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

import { IndexedDBStore } from './store.js'

/** IndexedDB에 스레드 대화와 상태를 보관합니다. */
export class IndexedDBSessionService extends SessionService {
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: IndexedDBStore
  ) {
    super(ctx)
    ctx.fiber.effect(() => () => {
      this.closed = true
    })
  }

  async get(threadId: string, options?: ExecutionOptions): Promise<SessionSnapshot | undefined> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    return this.store.getThread(threadId, options?.signal)
  }

  async prepare(input: RunAgentInput, options?: ExecutionOptions): Promise<PreparedSession> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const request = parseRunAgentInput(input)
    const thread = await this.store.prepareThread(request.threadId, options?.signal)
    options?.signal?.throwIfAborted()
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
    return this.store.commit(change, options?.signal)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('indexeddb session service disposed')
  }
}
