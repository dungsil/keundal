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

import { GenerationRecorder } from './messages.js'
import type { MemoryStore, StoredRun } from './store.js'

function snapshot(record: StoredRun): GenerationSnapshot {
  return {
    request: record.request,
    status: record.status,
    journal: [...record.journal],
    messages: [...record.messages]
  }
}

/**
 * 준비된 입력을 LLM 스트림에 연결하고 실행 수명 이벤트, journal, 세션 커밋을 담당합니다. 실행 중에는
 * 부분 응답과 journal을 저장소에 남기고, 종료 상태는 세션 커밋과 함께 확정합니다. 성공한
 * RUN_FINISHED는 커밋 이후에 전달합니다.
 */
export class MemoryGenerationService extends GenerationService {
  private readonly controllers = new Set<AbortController>()
  private readonly active = new Set<string>()
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: MemoryStore
  ) {
    super(ctx)
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const controller of this.controllers) {
        controller.abort(new Error('memory generation service disposed'))
      }
    })
  }

  run(request: GenerationRequest, options: ExecutionOptions = {}): AsyncIterableIterator<AGUIEvent> {
    this.assertOpen()
    const controller = new globalThis.AbortController()
    const external = options.signal
    const abort = () => controller.abort(external?.reason)
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
      if (!controller.signal.aborted) controller.abort(new Error('memory generation run stopped'))
      cleanup()
    }
    const iterator = this.execute(request, controller.signal, () => stopped)
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
    const record = this.store.runs.get(runId)
    return record ? snapshot(record) : undefined
  }

  /**
   * 저장된 실행을 모두 생성 순서대로 반환하고, 실행 중이던 기록은 interrupted로 확정합니다. 이
   * 서비스가 실행 중인 실행은 건드리지 않으며, LLM을 다시 호출하지 않습니다.
   */
  async recover(options?: ExecutionOptions): Promise<GenerationSnapshot[]> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const recovered: GenerationSnapshot[] = []
    for (const record of this.store.runs.values()) {
      if (record.status === 'running' && !this.active.has(record.runId)) record.status = 'interrupted'
      recovered.push(snapshot(record))
    }
    return recovered
  }

  private async *execute(
    request: GenerationRequest,
    signal: AbortSignal,
    stopped: () => boolean
  ): AsyncGenerator<AGUIEvent, void, unknown> {
    const { threadId, runId } = request.input
    const recorder = new GenerationRecorder()
    let settled = false
    const finish = async (status: Exclude<GenerationStatus, 'running'>) => {
      if (settled) return
      settled = true
      const terminal: TerminalGeneration = {
        request,
        status,
        journal: [...recorder.journal],
        messages: [...recorder.messages]
      }
      // 종료를 확정한 실행만 대화에 반영하고, 그 밖의 종료는 부분 응답을 실행 기록에만 남깁니다.
      await this.ctx.session.commit({
        threadId,
        expectedRevision: request.sessionRevision,
        messages: status === 'completed' ? terminal.messages : [],
        state: status === 'completed' ? request.input.state : undefined,
        generation: terminal
      })
    }

    try {
      signal.throwIfAborted()
      this.validate(request)
      if (this.store.runs.has(runId)) throw new Error(`generation run is already recorded: ${runId}`)
      this.store.runs.set(runId, {
        runId,
        threadId,
        request,
        status: 'running',
        journal: recorder.journal,
        messages: recorder.messages
      })
      this.active.add(runId)
      const started: AGUIEvent = { type: EventType.RUN_STARTED, threadId, runId }
      recorder.record(started)
      yield started

      for await (const event of this.ctx.llm.stream(request, { signal })) {
        signal.throwIfAborted()
        recorder.record(event)
        yield event
      }
      signal.throwIfAborted()
      const finished: AGUIEvent = { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } }
      recorder.record(finished)
      await finish('completed')
      yield finished
    } catch (error) {
      // 서비스가 해제되는 중이면 실행을 남겨 두고 recover()가 interrupted로 확정합니다.
      if (!this.closed) await finish(stopped() ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed')
      throw error
    } finally {
      // 소비자가 순회를 중단한 실행은 남은 부분 응답과 함께 interrupted로 확정합니다.
      if (!this.closed) await finish('interrupted')
      this.active.delete(runId)
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
