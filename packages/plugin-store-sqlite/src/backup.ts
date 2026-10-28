import { BackupService, type HistoryBackup } from '@keundal/backup'
import type { Context } from 'cordis'

import type { SqliteStore } from './store.js'

export class SqliteBackupService extends BackupService {
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: SqliteStore
  ) {
    super(ctx)
    store.retain()
    ctx.fiber.effect(() => () => {
      this.closed = true
      store.release()
    })
  }

  async export(): Promise<HistoryBackup> {
    if (this.closed) throw new Error('sqlite backup service is closed')
    return this.store.exportHistory()
  }

  async import(data: HistoryBackup): Promise<void> {
    if (this.closed) throw new Error('sqlite backup service is closed')
    this.store.importHistory(data)
  }
}
