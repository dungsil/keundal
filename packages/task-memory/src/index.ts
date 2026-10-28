import { EventType, MessageAssembly, type AGUIEvent, type ExecutionOptions, type RunAgentInput } from '@keundal/core'
import { TaskService, type TaskRequest, type TaskSnapshot, type TaskStore } from '@keundal/task'
import type { Context } from 'cordis'

export interface MemoryTaskOptions {
  /** Global concurrency for this service, across all parent threads. Defaults to 8. */
  maxActive?: number
  /** Optional durable snapshot store; see its ownership requirements. */
  store?: TaskStore
}

interface PendingTask {
  snapshot: TaskSnapshot
  input: RunAgentInput
  run: (input: RunAgentInput, options: ExecutionOptions) => AsyncIterable<AGUIEvent>
}

export class MemoryTaskService extends TaskService {
  private readonly maxActive: number
  private readonly snapshots = new Map<string, TaskSnapshot>()
  private readonly queue: PendingTask[] = []
  private readonly active = new Map<string, { controller: globalThis.AbortController; settled: Promise<void> }>()
  private closed = false
  private draining?: Promise<void>
  private readonly store?: TaskStore
  private readonly ready: Promise<void>
  private writes = Promise.resolve()
  private readonly releases = new Map<string, () => Promise<void>>()

  constructor(ctx: Context, options: MemoryTaskOptions = {}) {
    super(ctx)
    const maxActive = options.maxActive ?? 8
    if (!Number.isInteger(maxActive) || maxActive <= 0) {
      throw new RangeError('maxActive must be a positive integer')
    }
    this.maxActive = maxActive
    this.store = options.store
    this.ready = this.store?.recover() ?? Promise.resolve()
    // Public methods surface initialization/write errors; background promises must not leak rejections.
    void this.ready.catch(() => {})
    ctx.effect(() => () => this.dispose())
  }

  async enqueue(
    request: TaskRequest,
    run: (input: RunAgentInput, options: ExecutionOptions) => AsyncIterable<AGUIEvent>
  ): Promise<TaskSnapshot> {
    await this.ready
    if (this.closed) throw new Error('memory task service disposed')
    const input = globalThis.structuredClone(request.input)
    const now = Date.now()
    const snapshot: TaskSnapshot = {
      id: globalThis.crypto.randomUUID(),
      status: 'queued',
      threadId: input.threadId,
      runId: input.runId,
      parentThreadId: request.parentThreadId,
      parentRunId: request.parentRunId,
      ...(request.label === undefined ? {} : { label: request.label }),
      content: '',
      createdAt: now,
      updatedAt: now
    }
    const release = await this.store?.acquire(snapshot.id)
    if (release) this.releases.set(snapshot.id, release)
    try {
      await this.persist(snapshot)
    } catch (error) {
      await this.release(snapshot.id)
      throw error
    }
    if (this.closed) {
      snapshot.status = this.store ? 'interrupted' : 'cancelled'
      snapshot.updatedAt = Date.now()
      try {
        await this.persist(snapshot)
      } finally {
        await this.release(snapshot.id)
      }
      throw new Error('memory task service disposed')
    }
    this.snapshots.set(snapshot.id, snapshot)
    this.queue.push({ snapshot, input, run })
    this.pump()
    return { ...snapshot }
  }

  async get(id: string): Promise<TaskSnapshot | undefined> {
    await this.ready
    await this.writes
    if (this.store) return this.store.get(id)
    const snapshot = this.snapshots.get(id)
    return snapshot ? { ...snapshot } : undefined
  }

  async list(options: { parentThreadId?: string } = {}): Promise<TaskSnapshot[]> {
    await this.ready
    await this.writes
    if (this.store) return this.store.list(options)
    return [...this.snapshots.values()]
      .filter((snapshot) => options.parentThreadId === undefined || snapshot.parentThreadId === options.parentThreadId)
      .map((snapshot) => ({ ...snapshot }))
  }

  async cancel(id: string): Promise<boolean> {
    await this.ready
    return this.stop(id, 'cancelled')
  }

  private async stop(id: string, status: 'cancelled' | 'interrupted'): Promise<boolean> {
    const snapshot = this.snapshots.get(id)
    if (!snapshot || (snapshot.status !== 'queued' && snapshot.status !== 'running')) return false
    snapshot.status = status
    snapshot.updatedAt = Date.now()
    const index = this.queue.findIndex((task) => task.snapshot.id === id)
    if (index !== -1) this.queue.splice(index, 1)
    this.active.get(id)?.controller.abort(new Error('task cancelled'))
    try {
      await this.persist(snapshot)
    } finally {
      if (index !== -1) await this.release(id)
    }
    return true
  }

  dispose(): Promise<void> {
    if (this.draining) return this.draining
    this.closed = true
    const drained = Promise.withResolvers<void>()
    this.draining = drained.promise
    const stops = [...this.snapshots.keys()].map((id) => this.stop(id, this.store ? 'interrupted' : 'cancelled'))
    void Promise.allSettled([this.ready, ...stops, ...[...this.active.values()].map((task) => task.settled)])
      .then((results) => {
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
        return this.writes
      })
      .then(() => drained.resolve(), drained.reject)
    return this.draining
  }

  private pump(): void {
    while (!this.closed && this.active.size < this.maxActive && this.queue.length) {
      const task = this.queue.shift()!
      task.snapshot.status = 'running'
      task.snapshot.updatedAt = Date.now()
      const controller = new globalThis.AbortController()
      const running = this.persist(task.snapshot)
      // Defer user code until the active slot and its settlement promise are registered.
      const settled = Promise.resolve()
        .then(async () => {
          try {
            await running
            await this.consume(task, controller.signal)
          } finally {
            this.active.delete(task.snapshot.id)
            await this.release(task.snapshot.id)
            this.pump()
          }
        })
        .catch(() => {
          // A durable write failure is exposed by get/list/enqueue/dispose through this.writes.
          this.closed = true
          for (const active of this.active.values()) active.controller.abort(new Error('task storage failed'))
        })
      this.active.set(task.snapshot.id, { controller, settled })
    }
  }

  private async consume(task: PendingTask, signal: AbortSignal): Promise<void> {
    const snapshot = task.snapshot
    if (signal.aborted) return
    const assembly = new MessageAssembly()
    let finished = false
    try {
      for await (const event of task.run(task.input, { signal })) {
        if (signal.aborted) break
        if (event.type === EventType.RUN_FINISHED) {
          if (event.outcome?.type === 'success') finished = true
          else snapshot.error ??= 'task did not finish successfully'
        }
        if (event.type === EventType.RUN_ERROR) snapshot.error = event.message
        assembly.apply(event)
        snapshot.content = assembly.messages
          .filter((message) => message.role === 'assistant' && typeof message.content === 'string')
          .map((message) => message.content)
          .join('')
        snapshot.updatedAt = Date.now()
        await this.persist(snapshot)
      }
      if (!signal.aborted) {
        if (!finished && snapshot.error === undefined) snapshot.error = 'task stream ended without RUN_FINISHED'
        snapshot.status = finished && snapshot.error === undefined ? 'completed' : 'failed'
      }
    } catch (error) {
      if (!signal.aborted) {
        snapshot.status = 'failed'
        snapshot.error =
          error instanceof Error ? error.message : typeof error === 'string' ? error : 'task execution failed'
      }
    } finally {
      if (!signal.aborted) snapshot.updatedAt = Date.now()
      await this.persist(snapshot)
    }
  }

  private persist(snapshot: TaskSnapshot): Promise<void> {
    if (!this.store) return Promise.resolve()
    const copy = { ...snapshot }
    this.writes = this.writes.then(() => this.store!.save(copy))
    void this.writes.catch(() => {})
    return this.writes
  }

  private async release(id: string): Promise<void> {
    const release = this.releases.get(id)
    this.releases.delete(id)
    await release?.()
  }
}

export function apply(ctx: Context, options: MemoryTaskOptions = {}): void {
  new MemoryTaskService(ctx, options)
}

export default apply
