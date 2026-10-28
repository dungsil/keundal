import type { AGUIEvent, ExecutionOptions, RunAgentInput } from '@keundal/core'
import { Service, type Context } from 'cordis'

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface TaskRequest {
  input: RunAgentInput
  parentThreadId: string
  parentRunId: string
  label?: string
}

export interface TaskSnapshot {
  id: string
  status: TaskStatus
  threadId: string
  runId: string
  parentThreadId: string
  parentRunId: string
  label?: string
  /** Assistant text assembled in message order, including partial output on failure/cancellation. */
  content: string
  error?: string
  createdAt: number
  updatedAt: number
}

/** Durable snapshots only; execution callbacks and credentials must never be stored here. */
export abstract class TaskStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'taskStore')
  }

  abstract get(id: string): Promise<TaskSnapshot | undefined>
  abstract list(options?: { parentThreadId?: string }): Promise<TaskSnapshot[]>
  abstract save(snapshot: TaskSnapshot): Promise<void>
  /** Stores without cross-context locks require a single executor per database. */
  async acquire(_id: string): Promise<() => Promise<void>> {
    return async () => {}
  }
  /** Marks abandoned queued/running snapshots interrupted, preserving all output. Never executes work. */
  abstract recover(): Promise<void>
}

/** Background tasks have independent cancellation and no automatic retry or resume. */
export abstract class TaskService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tasks')
  }

  /**
   * The callback is ephemeral execution state: it is never persisted or replayed,
   * and is released after execution or cancellation of a queued task.
   * All returned snapshots, including get/list results, are independent copies.
   */
  abstract enqueue(
    request: TaskRequest,
    run: (input: RunAgentInput, options: ExecutionOptions) => AsyncIterable<AGUIEvent>
  ): Promise<TaskSnapshot>

  abstract get(id: string): Promise<TaskSnapshot | undefined>

  abstract list(options?: { parentThreadId?: string }): Promise<TaskSnapshot[]>

  /** Returns false for missing or already terminal tasks. */
  abstract cancel(id: string): Promise<boolean>

  /** Stops accepting work and waits for runners to settle. Durable unfinished tasks become interrupted. */
  abstract dispose(): Promise<void>
}

declare module 'cordis' {
  interface Context {
    readonly tasks: TaskService
    readonly taskStore: TaskStore
  }
}
