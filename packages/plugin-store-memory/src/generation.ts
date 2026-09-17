import {
  EventType,
  GenerationService,
  type AGUIEvent,
  type ExecutionOptions,
  type GenerationOptions,
  type GenerationRequest,
  type GenerationSnapshot,
  type GenerationStatus,
  type TerminalGeneration
} from '@keundal/core'
import type { Context } from 'cordis'

import { GenerationRecorder } from './messages.js'
import type { MemoryStore, StoredRun } from './store.js'
const snapshot = (r: StoredRun): GenerationSnapshot => ({
  request: r.request,
  status: r.status,
  journal: [...r.journal],
  messages: [...r.messages]
})
export class MemoryGenerationService extends GenerationService {
  private readonly controllers = new Set<globalThis.AbortController>()
  private readonly active = new Map<string, AbortSignal>()
  private readonly owner = Symbol('generation-service')
  private closed = false
  constructor(
    ctx: Context,
    private readonly store: MemoryStore
  ) {
    super(ctx)
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const run of this.store.runs.values())
        if (run.owner === this.owner && run.status === 'running') run.lease.active = false
      for (const c of this.controllers) c.abort(new Error('memory generation service disposed'))
    })
  }
  run(request: GenerationRequest, options: GenerationOptions = {}): AsyncIterableIterator<AGUIEvent> {
    this.assertOpen()
    const controller = new globalThis.AbortController()
    const token = Symbol('generation-run')
    const external = options.signal
    const abort = () => {
      controller.abort(external?.reason)
      if (external?.aborted && !this.closed) {
        const record = this.store.runs.get(request.input.runId)
        if (record?.owner === this.owner && record.token === token && record.status === 'running') {
          const terminal: TerminalGeneration = {
            request,
            status: 'cancelled',
            journal: [...record.journal],
            messages: [...record.messages]
          }
          void this.ctx.session
            .commit({
              threadId: request.input.threadId,
              expectedRevision: request.sessionRevision,
              messages: [],
              state: undefined,
              generation: terminal
            })
            .catch(() => {})
          record.status = 'cancelled'
          record.owner = undefined
          record.lease.active = false
          record.journal = [...record.journal]
          record.messages = [...record.messages]
        }
      }
    }
    const cleanup = () => {
      external?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', cleanup)
      this.controllers.delete(controller)
    }
    this.controllers.add(controller)
    controller.signal.addEventListener('abort', cleanup, { once: true })
    if (external?.aborted) abort()
    else external?.addEventListener('abort', abort, { once: true })
    let stopped = false
    const iterator = this.execute(
      request,
      controller.signal,
      token,
      () => stopped,
      () => {
        stopped = true
        if (!controller.signal.aborted) controller.abort(new Error('memory generation run stopped'))
        cleanup()
      },
      options.stream
    )
    return {
      next: () => iterator.next(),
      return: async () => {
        stopped = true
        if (!controller.signal.aborted) controller.abort(new Error('memory generation run stopped'))
        cleanup()
        return iterator.return(undefined)
      },
      throw: async (reason?: unknown) => {
        stopped = true
        if (!controller.signal.aborted) controller.abort(new Error('memory generation run stopped'))
        cleanup()
        return iterator.throw(reason)
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }
  async get(runId: string, options?: ExecutionOptions): Promise<GenerationSnapshot | undefined> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const r = this.store.runs.get(runId)
    return r ? snapshot(r) : undefined
  }
  async recover(options?: ExecutionOptions): Promise<GenerationSnapshot[]> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const out: GenerationSnapshot[] = []
    for (const r of this.store.runs.values()) {
      if (r.status === 'running' && (!r.lease.active || (r.owner === this.owner && !this.active.has(r.runId)))) {
        r.status = 'interrupted'
        r.journal = [...r.journal]
        r.messages = [...r.messages]
      }
      out.push(snapshot(r))
    }
    return out
  }
  private async *execute(
    request: GenerationRequest,
    signal: AbortSignal,
    token: symbol,
    stopped: () => boolean,
    stop: () => void,
    stream?: GenerationOptions['stream']
  ): AsyncGenerator<AGUIEvent, void, unknown> {
    const { threadId, runId } = request.input
    const recorder = new GenerationRecorder()
    let record: StoredRun | undefined
    let settled = false
    let registered = false
    const current = () =>
      record !== undefined &&
      this.store.runs.get(runId) === record &&
      record.owner === this.owner &&
      record.status === 'running'
    const finish = async (status: Exclude<GenerationStatus, 'running'>) => {
      if (settled || !registered || !current() || !record) return
      const activeRecord = record
      settled = true
      const terminal: TerminalGeneration = {
        request,
        status,
        journal: [...recorder.journal],
        messages: [...recorder.messages]
      }
      await this.ctx.session.commit({
        threadId,
        expectedRevision: request.sessionRevision,
        messages: status === 'completed' ? terminal.messages : [],
        state: status === 'completed' ? request.input.state : undefined,
        generation: terminal
      })
      if (this.store.runs.get(runId) === activeRecord) {
        activeRecord.status = status
        activeRecord.journal = terminal.journal
        activeRecord.messages = terminal.messages
        activeRecord.owner = undefined
        activeRecord.lease.active = false
      }
    }
    try {
      signal.throwIfAborted()
      this.validate(request)
      if (this.store.runs.has(runId)) throw new Error(`generation run is already recorded: ${runId}`)
      if (!this.store.threads.has(threadId))
        this.store.threads.set(threadId, { revision: 0, messages: [], state: undefined })
      record = {
        runId,
        threadId,
        request,
        status: 'running',
        journal: recorder.journal,
        messages: recorder.messages,
        owner: this.owner,
        token,
        lease: { active: true }
      }
      this.store.runs.set(runId, record)
      registered = true
      this.active.set(runId, signal)
      const started: AGUIEvent = { type: EventType.RUN_STARTED, threadId, runId }
      recorder.record(started)
      yield started
      signal.throwIfAborted()
      const events = stream ? stream(request, { signal }) : this.ctx.llm.stream(request, { signal })
      for await (const event of events) {
        signal.throwIfAborted()
        if (!current()) return
        recorder.record(event)
        yield event
      }
      signal.throwIfAborted()
      if (!current()) return
      const finished: AGUIEvent = { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } }
      const journal = [...recorder.journal, { sequence: recorder.journal.length, event: finished }]
      const terminal: TerminalGeneration = { request, status: 'completed', journal, messages: [...recorder.messages] }
      await this.ctx.session.commit({
        threadId,
        expectedRevision: request.sessionRevision,
        messages: terminal.messages,
        state: request.input.state,
        generation: terminal
      })
      if (this.store.runs.get(runId) === record) {
        record.status = 'completed'
        record.journal = journal
        record.messages = terminal.messages
        record.owner = undefined
        record.lease.active = false
      }
      settled = true
      yield finished
    } catch (error) {
      if (!this.closed) {
        try {
          await finish(stopped() ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed')
        } catch {
          // 원래 스트림 오류를 보존하고, finally에서 lease를 만료시킵니다.
        }
      }
      if (record?.token === token && record.status === 'running') {
        record.status = 'interrupted'
        record.owner = undefined
        record.lease.active = false
        record.journal = [...record.journal]
        record.messages = [...record.messages]
      }
      throw error
    } finally {
      try {
        if (!this.closed) {
          try {
            await finish('interrupted')
          } finally {
            if (record?.token === token && record.status === 'running') {
              record.status = 'interrupted'
              record.owner = undefined
              record.lease.active = false
              record.journal = [...record.journal]
              record.messages = [...record.messages]
            }
          }
        }
      } finally {
        if (this.active.get(runId) === signal) this.active.delete(runId)
        if (record?.token === token && record.status === 'running') record.lease.active = false
        stop()
      }
    }
  }
  private validate(request: GenerationRequest): void {
    const { threadId, runId } = request.input
    if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('threadId must be a non-empty string')
    if (typeof runId !== 'string' || !runId.trim()) throw new Error('runId must be a non-empty string')
    if (!Number.isSafeInteger(request.sessionRevision) || request.sessionRevision < 0)
      throw new Error('sessionRevision must be a non-negative integer')
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
      throw new Error('maxOutputTokens must be a positive integer')
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('memory generation service disposed')
  }
}
