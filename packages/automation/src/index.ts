import type { RunAgentInput } from '@keundal/core'
import type { TaskSnapshot } from '@keundal/task'
import { Service, type Context } from 'cordis'

export type AutomationTrigger =
  | { type: 'cron'; expression: string; timezone: string }
  | { type: 'webhook' }
  | { type: 'event'; name: string }

export interface AutomationDefinition {
  label: string
  enabled: boolean
  trigger: AutomationTrigger
  /** Serializable input template, without credentials or execution callbacks. */
  input: Omit<RunAgentInput, 'threadId' | 'runId'>
}

export interface AutomationSnapshot extends AutomationDefinition {
  id: string
  nextRunAt?: number
}

export interface AutomationEvent {
  /** Stable delivery ID, reused when a sender retries. Required even without a payload. */
  id: string
  payload?: unknown
}

export interface AutomationAttempt {
  id: string
  automationId: string
  key: string
  runId: string
  status: 'dispatching' | 'submitted' | 'failed' | 'interrupted' | 'skipped'
  createdAt: number
  taskId?: string
  error?: string
}

/** Single executor per database, matching TaskStore ownership. Claims survive definition deletion. */
export abstract class AutomationStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'automationStore')
  }

  abstract list(): Promise<AutomationSnapshot[]>
  abstract save(automation: AutomationSnapshot): Promise<void>
  abstract delete(id: string): Promise<void>
  /** Atomically inserts a unique (automationId, key); false means already received. */
  abstract claim(attempt: AutomationAttempt): Promise<boolean>
  abstract saveAttempt(attempt: AutomationAttempt): Promise<void>
  abstract attempts(automationId?: string): Promise<AutomationAttempt[]>
}

export interface AutomationHistory extends AutomationAttempt {
  /** Live or recovered TaskService result, including partial output and execution errors. */
  task?: TaskSnapshot
}

export abstract class AutomationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'automation')
  }

  abstract list(): Promise<AutomationSnapshot[]>
  abstract put(id: string, definition: AutomationDefinition): Promise<AutomationSnapshot>
  abstract delete(id: string): Promise<void>
  abstract webhook(id: string, event: AutomationEvent): Promise<AutomationHistory[]>
  abstract emit(name: string, event: AutomationEvent): Promise<AutomationHistory[]>
  abstract history(automationId?: string): Promise<AutomationHistory[]>
  /** Stops accepting triggers and drains dispatch, without cancelling submitted tasks. */
  abstract dispose(): Promise<void>
}

declare module 'cordis' {
  interface Context {
    readonly automation: AutomationService
    readonly automationStore: AutomationStore
  }
}
