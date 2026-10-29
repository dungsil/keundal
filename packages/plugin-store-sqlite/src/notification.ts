import { NotificationStore, type NotificationDelivery } from '@keundal/notification'
import type { Context } from 'cordis'

import type { SqliteStore } from './store.js'

export class SqliteNotificationStore extends NotificationStore {
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: SqliteStore
  ) {
    super(ctx)
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        target TEXT NOT NULL, notification_id TEXT NOT NULL, snapshot TEXT NOT NULL,
        PRIMARY KEY (target, notification_id)
      ) STRICT;
    `)
    store.retain()
    ctx.fiber.effect(() => () => {
      this.closed = true
      store.release()
    })
  }

  async claim(delivery: NotificationDelivery): Promise<boolean> {
    this.assertOpen()
    return (
      this.store.database
        .prepare(`INSERT INTO notification_deliveries (target, notification_id, snapshot)
        VALUES (?, ?, ?) ON CONFLICT (target, notification_id) DO NOTHING`)
        .run(delivery.target, delivery.notification.id, JSON.stringify(delivery)).changes === 1
    )
  }

  async save(delivery: NotificationDelivery): Promise<void> {
    this.assertOpen()
    this.store.database
      .prepare(`INSERT INTO notification_deliveries (target, notification_id, snapshot)
      VALUES (?, ?, ?) ON CONFLICT (target, notification_id) DO UPDATE SET snapshot = excluded.snapshot`)
      .run(delivery.target, delivery.notification.id, JSON.stringify(delivery))
  }

  async list(target: string): Promise<NotificationDelivery[]> {
    this.assertOpen()
    return this.store.database
      .prepare('SELECT snapshot FROM notification_deliveries WHERE target = ? ORDER BY rowid')
      .all(target)
      .map((row) => JSON.parse(row.snapshot as string) as NotificationDelivery)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite notification store disposed')
  }
}
