import { randomUUID } from 'node:crypto'
import { clearInterval, setInterval } from 'node:timers'

import {
  EventType,
  GenerationService,
  type AGUIEvent,
  type ExecutionOptions,
  type GenerationRequest,
  type GenerationSnapshot,
  type GenerationStatus,
  type TerminalGeneration
} from '@keundal/core'
import type { Context } from 'cordis'

import { RunRecorder } from './messages.js'
import type { SqliteStore, StoredRun } from './store.js'

/** 다른 소유자가 실행을 넘겨받았다고 보기 전까지 실행을 보호하는 기간입니다. */
const LEASE_MS = 30_000
/** 임차를 연장하는 주기입니다. */
const HEARTBEAT_MS = 10_000

type TerminalStatus = Exclude<GenerationStatus, 'running'>

/** 이 서비스가 실행 중인 실행입니다. */
interface ActiveRun {
  readonly runId: string
  readonly threadId: string
  readonly request: GenerationRequest
  readonly recorder: RunRecorder
  /** 같은 runId를 사용하는 다른 반복자와 구분합니다. */
  readonly token: symbol
  settled: boolean
}

const snapshot = (run: StoredRun): GenerationSnapshot => ({
  request: run.request,
  status: run.status,
  journal: run.journal,
  messages: run.messages
})

/**
 * 실행 기록을 SQLite 저장소에 보관합니다. RUN_STARTED부터 순서대로 journal과 실행 메시지를 이벤트마다
 * 기록하고, 실행이 끝나면 세션 커밋과 종료 상태를 하나의 트랜잭션으로 확정한 뒤 RUN_FINISHED를
 * 전달합니다. 실행은 소유자별 임차로 보호되므로 다른 프로세스의 recover()가 실행 중인 기록을
 * 중단시키지 않습니다.
 */
export class SqliteGenerationService extends GenerationService {
  private readonly controllers = new Set<globalThis.AbortController>()
  private readonly active = new Map<string, ActiveRun>()
  private readonly ownerId = randomUUID()
  private heartbeat?: NodeJS.Timeout
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: SqliteStore
  ) {
    super(ctx)
    store.retain()
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const controller of this.controllers) controller.abort(new Error('SQLite generation service disposed'))
      this.stopHeartbeat()
      try {
        // 해제한 서비스가 소유하던 실행은 다른 프로세스의 recover()가 확정할 수 있게 합니다.
        this.store.releaseLeases(this.ownerId)
      } finally {
        this.store.release()
      }
    })
  }

  run(request: GenerationRequest, options: ExecutionOptions = {}): AsyncIterableIterator<AGUIEvent> {
    this.assertOpen()
    const { runId } = request.input
    const controller = new globalThis.AbortController()
    const token = Symbol('generation-run')
    const external = options.signal
    const abort = () => {
      controller.abort(external?.reason)
      // 외부 취소는 소비자가 순회를 이어가지 않아도 종료를 확정합니다.
      const active = this.active.get(runId)
      if (active?.token === token) void this.settle(active, 'cancelled').catch(() => {})
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
    const stop = () => {
      stopped = true
      if (!controller.signal.aborted) controller.abort(new Error('SQLite generation run stopped'))
      cleanup()
    }
    const iterator = this.execute(request, controller.signal, token, () => stopped)
    return {
      next: () => iterator.next(),
      return: async () => {
        stop()
        return iterator.return(undefined)
      },
      throw: async (reason?: unknown) => {
        stop()
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
    const run = this.store.readRun(runId)
    return run && snapshot(run)
  }

  /**
   * 저장된 부분 응답과 실행 상태를 복원합니다. 다른 소유자가 임차를 연장하고 있는 실행은 실행 중으로
   * 두고, 그 밖의 미완료 실행은 interrupted로 확정합니다. LLM은 다시 호출하지 않습니다.
   */
  async recover(options?: ExecutionOptions): Promise<GenerationSnapshot[]> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const now = Date.now()
    this.store.transaction(() => {
      for (const ownership of this.store.listOwnerships()) {
        if (ownership.status !== 'running') continue
        if (ownership.ownerId !== this.ownerId && (ownership.leaseExpiresAt ?? 0) > now) continue
        if (ownership.ownerId === this.ownerId && this.active.has(ownership.runId)) continue
        this.store.finishRun(ownership.runId, 'interrupted')
      }
    })
    return this.store.listRuns().map(snapshot)
  }

  private async *execute(
    request: GenerationRequest,
    signal: AbortSignal,
    token: symbol,
    stopped: () => boolean
  ): AsyncGenerator<AGUIEvent, void, unknown> {
    const { threadId, runId } = request.input
    let run: ActiveRun | undefined
    try {
      signal.throwIfAborted()
      this.validate(request)
      const registered = this.store.transaction(() => {
        this.store.ensureThread(threadId)
        return this.store.registerRun(runId, threadId, request, this.ownerId, Date.now() + LEASE_MS)
      })
      if (!registered) throw new Error(`generation run is already recorded: ${runId}`)
      run = {
        runId,
        threadId,
        request,
        recorder: new RunRecorder(this.store, runId, this.ownerId),
        token,
        settled: false
      }
      this.active.set(runId, run)
      this.startHeartbeat()

      const started: AGUIEvent = { type: EventType.RUN_STARTED, threadId, runId }
      run.recorder.record(started)
      yield started
      signal.throwIfAborted()
      for await (const event of this.ctx.llm.stream(request, { signal })) {
        signal.throwIfAborted()
        // 실행이 종료를 확정했거나 다른 소유자가 넘겨받았으면 기록을 멈춥니다.
        if (!run.recorder.record(event)) return
        yield event
      }
      signal.throwIfAborted()
      const finished: AGUIEvent = { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } }
      await this.settle(run, 'completed', finished)
      yield finished
    } catch (error) {
      await this.conclude(run, stopped(), signal).catch(() => {})
      throw error
    } finally {
      if (run && this.active.get(runId)?.token === token) this.active.delete(runId)
      if (!this.active.size) this.stopHeartbeat()
      await this.conclude(run, stopped(), signal)
    }
  }

  /**
   * 실행을 종료 상태로 확정합니다. 종료 상태는 세션 커밋과 함께 저장되며, 커밋이 실패하면 실행을
   * interrupted로 남겨 recover()가 다시 확정할 수 있게 합니다.
   */
  private async settle(run: ActiveRun, status: TerminalStatus, finished?: AGUIEvent): Promise<void> {
    if (run.settled) return
    run.settled = true
    const stored = this.store.readRun(run.runId)
    if (!stored) return
    const generation: TerminalGeneration = {
      request: run.request,
      status,
      journal: finished ? [...stored.journal, { sequence: stored.journal.length, event: finished }] : stored.journal,
      messages: stored.messages
    }
    try {
      await this.ctx.session.commit({
        threadId: run.threadId,
        expectedRevision: run.request.sessionRevision,
        messages: status === 'completed' ? stored.messages : [],
        state: status === 'completed' ? run.request.input.state : undefined,
        generation
      })
    } catch (error) {
      this.store.abandonRun(run.runId, this.ownerId, 'interrupted')
      throw error
    }
  }

  /** 실행을 시작하지 못했거나 순회가 끝난 실행을 중단 원인에 맞는 상태로 확정합니다. */
  private async conclude(run: ActiveRun | undefined, stopped: boolean, signal: AbortSignal): Promise<void> {
    if (!run || run.settled || this.closed) return
    await this.settle(run, stopped ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed')
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

  /** 실행 중인 실행의 임차를 주기적으로 연장합니다. */
  private startHeartbeat(): void {
    if (this.heartbeat) return
    const timer = setInterval(() => {
      try {
        this.store.refreshLeases(this.ownerId, Date.now() + LEASE_MS)
      } catch {
        // 해제 중인 저장소의 연장 실패는 무시합니다.
      }
    }, HEARTBEAT_MS)
    timer.unref()
    this.heartbeat = timer
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite generation service disposed')
  }
}
