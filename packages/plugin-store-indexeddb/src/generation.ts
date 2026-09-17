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
import { IndexedDBStore } from './store.js'

interface ActiveRun {
  readonly request: GenerationRequest
  readonly token: symbol
  readonly release: () => Promise<void>
  readonly cleanup: () => void
  finalizing?: Promise<GenerationStatus | undefined>
}

/** 실행 journal과 종료 상태를 IndexedDB에 저장합니다. */
export class IndexedDBGenerationService extends GenerationService {
  private readonly controllers = new Set<AbortController>()
  private readonly active = new Map<string, ActiveRun>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: IndexedDBStore,
    private readonly closeStore = false
  ) {
    super(ctx)
    ctx.fiber.effect(() => () => this.dispose())
  }

  run(request: GenerationRequest, options: GenerationOptions = {}): AsyncIterableIterator<AGUIEvent> {
    this.assertOpen()
    const controller = new globalThis.AbortController()
    const token = Symbol('indexeddb-generation-run')
    const external = options.signal
    let stopped = false
    let cleaned = false
    const onAbort = () => {
      controller.abort(external?.reason)
      if (external?.aborted && !this.closed) {
        void this.finalize(request.input.runId, token, 'cancelled')
          .catch(() => {})
          .finally(() => this.releaseActive(request.input.runId, token))
      }
    }
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      external?.removeEventListener('abort', onAbort)
      controller.signal.removeEventListener('abort', cleanup)
      this.controllers.delete(controller)
    }
    this.controllers.add(controller)
    controller.signal.addEventListener('abort', cleanup, { once: true })
    if (external?.aborted) onAbort()
    else external?.addEventListener('abort', onAbort, { once: true })

    const iterator = this.execute(request, controller.signal, token, () => stopped, cleanup, options.stream)
    return {
      next: () => iterator.next(),
      return: async () => {
        stopped = true
        if (!controller.signal.aborted) controller.abort(new Error('indexeddb generation run stopped'))
        try {
          return await iterator.return(undefined)
        } finally {
          cleanup()
        }
      },
      throw: async (reason?: unknown) => {
        stopped = true
        if (!controller.signal.aborted) controller.abort(new Error('indexeddb generation run stopped'))
        try {
          return await iterator.throw(reason)
        } finally {
          cleanup()
        }
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }

  async get(runId: string, options?: ExecutionOptions): Promise<GenerationSnapshot | undefined> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    return this.store.getRun(runId)
  }

  async recover(options?: ExecutionOptions): Promise<GenerationSnapshot[]> {
    this.assertOpen()
    const signal = options?.signal ?? new globalThis.AbortController().signal
    signal.throwIfAborted()
    const runs = await this.store.listRuns()
    for (const run of runs) {
      if (run.status !== 'running') continue
      await this.store.recoverIfUnlocked(run.request.input.runId, signal, async () => {
        const latest = await this.store.getRun(run.request.input.runId)
        if (latest?.status === 'running') await this.store.markInterrupted(run.request.input.runId)
      })
    }
    return this.store.listRuns()
  }

  private async *execute(
    request: GenerationRequest,
    signal: AbortSignal,
    token: symbol,
    stopped: () => boolean,
    cleanup: () => void,
    stream?: GenerationOptions['stream']
  ): AsyncGenerator<AGUIEvent, void, unknown> {
    const { threadId, runId } = request.input
    let active: ActiveRun | undefined
    let registered = false
    const recorder = new GenerationRecorder()
    try {
      signal.throwIfAborted()
      this.validate(request)
      const locked = await this.track(this.store.withRunLock(runId, signal, async () => this.store.startRun(request)))
      if (this.closed || signal.aborted) {
        if (!this.closed && signal.aborted) await this.finishStartedRun(request, 'cancelled').catch(() => {})
        await locked.release()
        signal.throwIfAborted()
        return
      }
      active = { request, token, release: locked.release, cleanup }
      this.active.set(runId, active)
      registered = true
      signal.throwIfAborted()

      const started: AGUIEvent = { type: EventType.RUN_STARTED, threadId, runId }
      recorder.record(started)
      await this.track(this.store.appendEvent(runId, started))
      if (this.closed) return
      yield started

      signal.throwIfAborted()

      const events = stream ? stream(request, { signal }) : this.ctx.llm.stream(request, { signal })
      for await (const event of events) {
        signal.throwIfAborted()
        if (!this.isCurrent(runId, token)) return
        recorder.record(event)
        await this.track(this.store.appendEvent(runId, event))
        if (this.closed || !this.isCurrent(runId, token)) return
        yield event
      }
      signal.throwIfAborted()
      if (!this.isCurrent(runId, token)) return

      const finished: AGUIEvent = { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } }
      const terminal = await this.finalize(runId, token, 'completed', finished)
      if (terminal !== 'completed') {
        signal.throwIfAborted()
        return
      }
      await this.releaseActive(runId, token)
      yield finished
    } catch (error) {
      if (registered && !this.closed) {
        const status: Exclude<GenerationStatus, 'running'> = stopped()
          ? 'interrupted'
          : signal.aborted
            ? 'cancelled'
            : 'failed'
        await this.finalize(runId, token, status).catch(() => {})
      }
      throw error
    } finally {
      try {
        if (registered && !this.closed && this.isCurrent(runId, token))
          await this.finalize(runId, token, 'interrupted').catch(() => {})
      } finally {
        if (this.isCurrent(runId, token)) await this.releaseActive(runId, token)
        else if (active) await active.release()
        cleanup()
      }
    }
  }

  private async finalize(
    runId: string,
    token: symbol,
    status: Exclude<GenerationStatus, 'running'>,
    finished?: AGUIEvent
  ): Promise<GenerationStatus | undefined> {
    const active = this.active.get(runId)
    if (!active || active.token !== token) return undefined
    if (active.finalizing) return active.finalizing
    active.finalizing = (async () => {
      const snapshot = await this.track(this.store.getRun(runId))
      if (!snapshot || snapshot.status !== 'running') return snapshot?.status
      const journal = finished
        ? [...snapshot.journal, { sequence: snapshot.journal.length, event: finished }]
        : snapshot.journal
      const terminal: TerminalGeneration = { request: active.request, status, journal, messages: snapshot.messages }
      try {
        await this.track(
          this.ctx.session.commit({
            threadId: active.request.input.threadId,
            expectedRevision: active.request.sessionRevision,
            messages: status === 'completed' ? terminal.messages : [],
            state: status === 'completed' ? active.request.input.state : undefined,
            generation: terminal
          })
        )
        return status
      } catch (error) {
        // 완료 journal을 commit 전에 넣지 않았으므로 충돌한 성공 실행은 recover 가능한 interrupted로 남습니다.
        await this.track(this.store.markInterrupted(runId)).catch(() => {})
        throw error
      }
    })()
    return active.finalizing
  }

  private async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const controller of this.controllers) controller.abort(new Error('indexeddb generation service disposed'))
    await Promise.all([...this.inFlight].map((operation) => operation.catch(() => {})))
    const active = [...this.active.values()]
    await Promise.all(
      active.map(async (run) => {
        await run.finalizing?.catch(() => {})
        try {
          await run.release()
        } finally {
          run.cleanup()
        }
      })
    )
    this.active.clear()
    if (this.closeStore) this.store.close()
  }

  private isCurrent(runId: string, token: symbol): boolean {
    return this.active.get(runId)?.token === token
  }

  private async releaseActive(runId: string, token: symbol): Promise<void> {
    const active = this.active.get(runId)
    if (!active || active.token !== token) return
    this.active.delete(runId)
    try {
      await active.release()
    } finally {
      active.cleanup()
    }
  }

  private async finishStartedRun(
    request: GenerationRequest,
    status: Exclude<GenerationStatus, 'running'>
  ): Promise<void> {
    const snapshot = await this.track(this.store.getRun(request.input.runId))
    if (!snapshot || snapshot.status !== 'running') return
    try {
      await this.track(
        this.ctx.session.commit({
          threadId: request.input.threadId,
          expectedRevision: request.sessionRevision,
          messages: [],
          state: undefined,
          generation: { request, status, journal: snapshot.journal, messages: snapshot.messages }
        })
      )
    } catch (error) {
      await this.track(this.store.markInterrupted(request.input.runId)).catch(() => {})
      throw error
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation)
    return operation.finally(() => this.inFlight.delete(operation))
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
    if (this.closed) throw new Error('indexeddb generation service disposed')
  }
}
