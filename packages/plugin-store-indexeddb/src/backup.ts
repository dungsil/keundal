import { BackupService, type HistoryBackup } from '@keundal/backup'
import type { Context } from 'cordis'

import type { IndexedDBStore } from './store.js'

export class IndexedDBBackupService extends BackupService {
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

  async export(): Promise<HistoryBackup> {
    if (this.closed) throw new Error('indexeddb backup service is closed')
    return this.store.exportHistory()
  }

  async import(data: HistoryBackup): Promise<void> {
    if (this.closed) throw new Error('indexeddb backup service is closed')
    return this.store.importHistory(data)
  }
}
