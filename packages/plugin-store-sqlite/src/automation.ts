import { AutomationStore, type AutomationAttempt, type AutomationSnapshot } from '@keundal/automation'
import type { Context } from 'cordis'

import type { SqliteStore } from './store.js'

/** Shares the task database and its single-executor ownership requirement. */
export class SqliteAutomationStore extends AutomationStore {
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: SqliteStore
  ) {
    super(ctx)
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS automation_attempts (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, delivery_key TEXT NOT NULL,
        snapshot TEXT NOT NULL, UNIQUE (automation_id, delivery_key)
      ) STRICT;
    `)
    store.retain()
    ctx.fiber.effect(() => () => {
      this.closed = true
      store.release()
    })
  }

  async list(): Promise<AutomationSnapshot[]> {
    this.assertOpen()
    return this.store.database
      .prepare('SELECT snapshot FROM automations ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(row.snapshot as string) as AutomationSnapshot)
  }

  async save(automation: AutomationSnapshot): Promise<void> {
    this.assertOpen()
    this.store.database
      .prepare(`INSERT INTO automations (id, snapshot) VALUES (?, ?)
      ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot`)
      .run(automation.id, JSON.stringify(automation))
  }

  async delete(id: string): Promise<void> {
    this.assertOpen()
    this.store.database.prepare('DELETE FROM automations WHERE id = ?').run(id)
  }

  async claim(attempt: AutomationAttempt): Promise<boolean> {
    this.assertOpen()
    return (
      this.store.database
        .prepare(`INSERT INTO automation_attempts (id, automation_id, delivery_key, snapshot)
      VALUES (?, ?, ?, ?) ON CONFLICT (automation_id, delivery_key) DO NOTHING`)
        .run(attempt.id, attempt.automationId, attempt.key, JSON.stringify(attempt)).changes === 1
    )
  }

  async saveAttempt(attempt: AutomationAttempt): Promise<void> {
    this.assertOpen()
    this.store.database
      .prepare('UPDATE automation_attempts SET snapshot = ? WHERE id = ?')
      .run(JSON.stringify(attempt), attempt.id)
  }

  async attempts(automationId?: string): Promise<AutomationAttempt[]> {
    this.assertOpen()
    const rows =
      automationId === undefined
        ? this.store.database.prepare('SELECT snapshot FROM automation_attempts ORDER BY rowid').all()
        : this.store.database
            .prepare('SELECT snapshot FROM automation_attempts WHERE automation_id = ? ORDER BY rowid')
            .all(automationId)
    return rows.map((row) => JSON.parse(row.snapshot as string) as AutomationAttempt)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite automation store disposed')
  }
}
