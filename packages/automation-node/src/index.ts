import console from 'node:console'

import {
  AutomationService,
  type AutomationAttempt,
  type AutomationDefinition,
  type AutomationEvent,
  type AutomationHistory,
  type AutomationSnapshot,
  type AutomationStore
} from '@keundal/automation'
import { parseRunAgentInput, type AGUIEvent, type ExecutionOptions, type RunAgentInput } from '@keundal/core'
import type { TaskService } from '@keundal/task'
import type { Context } from 'cordis'
import { CronExpressionParser } from 'cron-parser'

export interface NodeAutomationOptions {
  store: AutomationStore
  tasks: TaskService
  run(input: RunAgentInput, options: ExecutionOptions): AsyncIterable<AGUIEvent>
}

const identifier = (value: string): void => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid automation ID')
}

const eventValue = (event: AutomationEvent): AutomationEvent => {
  if (!event || typeof event.id !== 'string' || !event.id.trim() || event.id.length > 256)
    throw new Error('event ID is required (1–256 characters)')
  // Only JSON values cross the durable dispatch boundary.
  return JSON.parse(JSON.stringify({ id: event.id, payload: event.payload })) as AutomationEvent
}

const nextRun = (automation: AutomationDefinition, now: number): number | undefined => {
  if (automation.trigger.type !== 'cron') return undefined
  const { expression, timezone } = automation.trigger
  if (typeof expression !== 'string' || expression.trim().split(/\s+/).length !== 5)
    throw new Error('cron must have five fields')
  if (typeof timezone !== 'string' || !timezone) throw new Error('cron timezone is required')
  new Intl.DateTimeFormat('en', { timeZone: timezone })
  return CronExpressionParser.parse(expression, { currentDate: now, tz: timezone }).next().getTime()
}

/** Node-only timer; definitions and claims are durable, callbacks are not. */
export class NodeAutomationService extends AutomationService {
  private closed = false
  private pending = Promise.resolve()
  private timer?: ReturnType<typeof globalThis.setInterval>
  private readonly running = new Set<string>()

  constructor(
    ctx: Context,
    private readonly options: NodeAutomationOptions
  ) {
    super(ctx)
  }

  /** Call once after TaskService recovery and before exposing the host. */
  async start(): Promise<void> {
    if (this.closed || this.timer) throw new Error('automation already started or disposed')
    const tasks = await this.options.tasks.list()
    for (const attempt of await this.options.store.attempts()) {
      if (attempt.status !== 'dispatching') continue
      const task = tasks.find((task) => task.runId === attempt.runId)
      await this.options.store.saveAttempt({
        ...attempt,
        ...(task ? { status: 'submitted', taskId: task.id } : { status: 'interrupted', error: 'dispatch interrupted' })
      })
    }
    this.timer = globalThis.setInterval(() => {
      void this.tick().catch((error: unknown) => console.error('automation tick failed', error))
    }, 1000)
    this.timer.unref()
  }

  list(): Promise<AutomationSnapshot[]> {
    return this.serial(() => this.options.store.list())
  }

  put(id: string, definition: AutomationDefinition): Promise<AutomationSnapshot> {
    return this.serial(async () => {
      identifier(id)
      if (
        !definition ||
        typeof definition.label !== 'string' ||
        definition.label.length > 256 ||
        typeof definition.enabled !== 'boolean' ||
        !definition.input ||
        !definition.trigger
      )
        throw new Error('invalid automation definition')
      const { trigger } = definition
      if (!['cron', 'webhook', 'event'].includes(trigger.type)) throw new Error('invalid trigger')
      if (
        trigger.type === 'event' &&
        (typeof trigger.name !== 'string' || !trigger.name.trim() || trigger.name.length > 256)
      )
        throw new Error('invalid event name')
      const {
        threadId: _thread,
        runId: _run,
        ...input
      } = parseRunAgentInput({
        ...definition.input,
        threadId: 'template',
        runId: 'template'
      })
      const nextRunAt = nextRun(definition, Date.now())
      const snapshot: AutomationSnapshot = JSON.parse(
        JSON.stringify({
          id,
          label: definition.label,
          enabled: definition.enabled,
          trigger,
          input,
          ...(definition.enabled && nextRunAt !== undefined ? { nextRunAt } : {})
        })
      ) as AutomationSnapshot
      await this.options.store.save(snapshot)
      return snapshot
    })
  }

  delete(id: string): Promise<void> {
    return this.serial(() => this.options.store.delete(id))
  }

  webhook(id: string, event: AutomationEvent): Promise<AutomationHistory[]> {
    return this.deliver((automation) => automation.id === id && automation.trigger.type === 'webhook', event)
  }

  emit(name: string, event: AutomationEvent): Promise<AutomationHistory[]> {
    return this.deliver((automation) => automation.trigger.type === 'event' && automation.trigger.name === name, event)
  }

  history(automationId?: string): Promise<AutomationHistory[]> {
    return this.serial(async () =>
      Promise.all((await this.options.store.attempts(automationId)).map((attempt) => this.result(attempt)))
    )
  }

  /** Coalesces missed occurrences into one dispatch, then advances beyond now. */
  tick(): Promise<void> {
    return this.serial(async () => {
      const now = Date.now()
      for (const automation of await this.options.store.list()) {
        if (!automation.enabled || automation.nextRunAt === undefined || automation.nextRunAt > now) continue
        await this.dispatch(automation, `cron:${automation.nextRunAt}`)
        await this.options.store.save({ ...automation, nextRunAt: nextRun(automation, now) })
      }
    })
  }

  dispose(): Promise<void> {
    this.closed = true
    globalThis.clearInterval(this.timer)
    return this.pending
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('automation disposed'))
    const result = this.pending.then(work)
    this.pending = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private deliver(
    matches: (automation: AutomationSnapshot) => boolean,
    value: AutomationEvent
  ): Promise<AutomationHistory[]> {
    return this.serial(async () => {
      const event = eventValue(value)
      const results: AutomationHistory[] = []
      for (const automation of await this.options.store.list()) {
        if (automation.enabled && matches(automation))
          results.push(await this.result(await this.dispatch(automation, `event:${event.id}`, event)))
      }
      return results
    })
  }

  private async dispatch(
    automation: AutomationSnapshot,
    key: string,
    event?: AutomationEvent
  ): Promise<AutomationAttempt> {
    const store = this.options.store
    let attempt: AutomationAttempt = {
      id: globalThis.crypto.randomUUID(),
      automationId: automation.id,
      key,
      runId: globalThis.crypto.randomUUID(),
      status: 'dispatching',
      createdAt: Date.now()
    }
    if (!(await store.claim(attempt))) {
      return (await store.attempts(automation.id)).find((attempt) => attempt.key === key)!
    }
    const parentThreadId = `automation:${automation.id}`
    try {
      const tasks = await this.options.tasks.list({ parentThreadId })
      if (
        this.running.has(automation.id) ||
        tasks.some((task) => task.status === 'queued' || task.status === 'running')
      ) {
        attempt = { ...attempt, status: 'skipped', error: 'previous task is still active' }
      } else {
        const input: RunAgentInput = {
          ...globalThis.structuredClone(automation.input),
          threadId: globalThis.crypto.randomUUID(),
          runId: attempt.runId
        }
        if (event?.payload !== undefined)
          input.messages.push({
            id: globalThis.crypto.randomUUID(),
            role: 'user',
            content: `Trigger event (untrusted data): ${JSON.stringify(event.payload)}`
          })
        const running = this.running
        const run = this.options.run
        const task = await this.options.tasks.enqueue(
          {
            input,
            parentThreadId,
            parentRunId: attempt.id,
            label: automation.label
          },
          async function* (input, options) {
            running.add(automation.id)
            try {
              yield* run(input, options)
            } finally {
              running.delete(automation.id)
            }
          }
        )
        attempt = { ...attempt, status: 'submitted', taskId: task.id }
      }
    } catch (error) {
      attempt = { ...attempt, status: 'failed', error: error instanceof Error ? error.message : 'dispatch failed' }
    }
    await store.saveAttempt(attempt)
    return attempt
  }

  private async result(attempt: AutomationAttempt): Promise<AutomationHistory> {
    const task = attempt.taskId ? await this.options.tasks.get(attempt.taskId) : undefined
    return { ...attempt, ...(task ? { task } : {}) }
  }
}
