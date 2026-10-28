import { TaskStore, type TaskSnapshot } from '@keundal/task'
import type { Context } from 'cordis'

import type { SqliteStore } from './store.js'

interface TaskRow {
  task_id: string
  status: TaskSnapshot['status']
  thread_id: string
  run_id: string
  parent_thread_id: string
  parent_run_id: string
  label: string | null
  content: string
  error: string | null
  created_at: number
  updated_at: number
}

const snapshot = (row: TaskRow): TaskSnapshot => ({
  id: row.task_id,
  status: row.status,
  threadId: row.thread_id,
  runId: row.run_id,
  parentThreadId: row.parent_thread_id,
  parentRunId: row.parent_run_id,
  ...(row.label === null ? {} : { label: row.label }),
  content: row.content,
  ...(row.error === null ? {} : { error: row.error }),
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

export class SqliteTaskStore extends TaskStore {
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

  async get(id: string): Promise<TaskSnapshot | undefined> {
    this.assertOpen()
    const row = this.store.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id)
    return row ? snapshot(row as unknown as TaskRow) : undefined
  }

  async list(options?: { parentThreadId?: string }): Promise<TaskSnapshot[]> {
    this.assertOpen()
    const rows =
      options?.parentThreadId === undefined
        ? this.store.database.prepare('SELECT * FROM tasks ORDER BY rowid').all()
        : this.store.database
            .prepare('SELECT * FROM tasks WHERE parent_thread_id = ? ORDER BY rowid')
            .all(options.parentThreadId)
    return (rows as unknown as TaskRow[]).map(snapshot)
  }

  async save(task: TaskSnapshot): Promise<void> {
    this.assertOpen()
    this.store.database
      .prepare(
        `INSERT INTO tasks (task_id, status, thread_id, run_id, parent_thread_id, parent_run_id,
          label, content, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (task_id) DO UPDATE SET
          status = excluded.status, thread_id = excluded.thread_id, run_id = excluded.run_id,
          parent_thread_id = excluded.parent_thread_id, parent_run_id = excluded.parent_run_id,
          label = excluded.label, content = excluded.content, error = excluded.error,
          created_at = excluded.created_at, updated_at = excluded.updated_at`
      )
      .run(
        task.id,
        task.status,
        task.threadId,
        task.runId,
        task.parentThreadId,
        task.parentRunId,
        task.label ?? null,
        task.content,
        task.error ?? null,
        task.createdAt,
        task.updatedAt
      )
  }

  async recover(): Promise<void> {
    this.assertOpen()
    this.store.database
      .prepare("UPDATE tasks SET status = 'interrupted', updated_at = ? WHERE status IN ('queued', 'running')")
      .run(Date.now())
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite task store disposed')
  }
}
