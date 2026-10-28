import { BackupService, parseHistoryBackup, type HistoryBackup } from '@keundal/backup'
import type { Context } from 'cordis'

import type { MemoryStore } from './store.js'

export class MemoryBackupService extends BackupService {
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

  private assertIdle(): void {
    if (this.closed) throw new Error('memory backup service is closed')
    if ([...this.store.runs.values()].some((run) => run.status === 'running'))
      throw new Error('cannot back up or import history with running generations')
  }

  async export(): Promise<HistoryBackup> {
    this.assertIdle()
    return parseHistoryBackup({
      threads: [...this.store.threads].map(([threadId, thread]) => ({ threadId, ...thread })),
      runs: [...this.store.runs.values()].map(({ request, status, journal, messages }) => ({
        request,
        status,
        journal,
        messages
      }))
    })
  }

  async import(data: HistoryBackup): Promise<void> {
    const parsed = parseHistoryBackup(data)
    this.assertIdle()
    for (const thread of parsed.threads)
      if (this.store.threads.has(thread.threadId)) throw new Error(`backup thread collision: ${thread.threadId}`)
    for (const run of parsed.runs)
      if (this.store.runs.has(run.request.input.runId))
        throw new Error(`backup run collision: ${run.request.input.runId}`)
    // All validation and cloning precedes these synchronous writes; no other task can interleave.
    for (const { threadId, ...thread } of parsed.threads) this.store.threads.set(threadId, thread)
    for (const run of parsed.runs)
      this.store.runs.set(run.request.input.runId, {
        ...run,
        runId: run.request.input.runId,
        threadId: run.request.input.threadId,
        lease: { active: false }
      })
  }
}
