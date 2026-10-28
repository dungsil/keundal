import { TaskStore, type TaskSnapshot } from '@keundal/task'
import type { Context } from 'cordis'

import type { IndexedDBStore } from './store.js'

export class IndexedDBTaskStore extends TaskStore {
  constructor(
    ctx: Context,
    private readonly store: IndexedDBStore
  ) {
    super(ctx)
  }

  get(id: string): Promise<TaskSnapshot | undefined> {
    return this.store.getTask(id)
  }

  list(options?: { parentThreadId?: string }): Promise<TaskSnapshot[]> {
    return this.store.listTasks(options)
  }

  save(snapshot: TaskSnapshot): Promise<void> {
    return this.store.saveTask(snapshot)
  }

  async acquire(id: string): Promise<() => Promise<void>> {
    const lock = await this.store.withRunLock(`task:${id}`, new globalThis.AbortController().signal, async () => {})
    return lock.release
  }

  recover(): Promise<void> {
    return this.store.recoverTasks()
  }
}
