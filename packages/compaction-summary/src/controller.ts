import type { CompactionResult, AgentCompactionConfig } from '@keundal/compaction'
import { CONTEXT_MESSAGE_PREFIX, EventType, type RunAgentInput } from '@keundal/core'
import { isContextOverflow, type LLMEvent, type LLMRequest, type LLMService } from '@keundal/llm'
import { TRACE_EVENT, LLM_USAGE_EVENT } from '@keundal/trace'
import { TraceRecorder, tracedCompactionLLM, tracedModelStream } from '@keundal/trace/recording'

import { compact } from './index.js'
import {
  parseCompactionConfig,
  matchesPrepared,
  applyPrepared,
  waitForPreparation,
  type PreparedCompaction
} from './preparation.js'

export { parseCompactionConfig } from './preparation.js'

export class SummaryCompactionController {
  private readonly preparations = new Map<string, PreparedCompaction>()
  readonly policy: AgentCompactionConfig

  constructor(
    private readonly llm: LLMService,
    private readonly config: Pick<LLMRequest, 'model' | 'maxOutputTokens' | 'webSearch' | 'reasoning'> & {
      readonly compaction?: AgentCompactionConfig
    }
  ) {
    this.policy = this.resolveCompactionPolicy()
  }

  dispose(): void {
    for (const entry of this.preparations.values()) {
      entry.detach()
      entry.controller.abort(new Error('agent disposed'))
    }
    this.preparations.clear()
  }

  detach(signal: AbortSignal): void {
    for (const entry of this.preparations.values()) if (entry.sourceSignal === signal) entry.detach()
  }

  private resolveCompactionPolicy() {
    const config = parseCompactionConfig(this.config.compaction)
    return config.models?.[this.config.model] ?? config
  }

  private discardPreparation(threadId: string, entry: PreparedCompaction) {
    if (this.preparations.get(threadId) === entry) this.preparations.delete(threadId)
    entry.detach()
    entry.controller.abort(new Error('compaction preparation discarded'))
  }

  private prepareCompaction(
    input: RunAgentInput,
    maxInputTokens: number,
    inputTokens: number,
    signal: AbortSignal,
    trace?: TraceRecorder
  ) {
    if (this.preparations.has(input.threadId)) return
    // 준비 결과와 진행 중 작업의 수를 함께 제한합니다.
    if (this.preparations.size >= 32) {
      const oldest = this.preparations.entries().next().value
      if (oldest) this.discardPreparation(...oldest)
    }
    let snapshot: RunAgentInput
    try {
      snapshot = globalThis.structuredClone(input)
      JSON.stringify(snapshot)
    } catch {
      // 복제·비교할 수 없는 상태는 준비를 생략하고 정상 생성을 계속합니다.
      return
    }
    const controller = new globalThis.AbortController()
    const abort = () => controller.abort(signal.reason)
    const detach = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    const entry: PreparedCompaction = {
      input: snapshot,
      controller,
      sourceSignal: signal,
      detach,
      task: Promise.resolve(undefined)
    }
    this.preparations.set(input.threadId, entry)
    const span = trace?.start('compaction', 'background_prepare', trace.root.spanId, undefined, undefined, true, true)
    const compactionLLM =
      span && trace ? tracedCompactionLLM(this.llm, trace, span.spanId, controller.signal, true) : this.llm
    entry.task = compact(
      compactionLLM,
      {
        input: entry.input,
        model: this.config.model,
        maxInputTokens
      },
      { ...this.policy, signal: controller.signal, inputTokens, force: true }
    ).then(
      (result) => {
        if (!controller.signal.aborted && this.preparations.get(input.threadId) === entry) entry.result = result
        if (span && trace) trace.finish(span, controller.signal.aborted ? 'cancelled' : 'completed')
        detach()
        return entry.result
      },
      () => {
        if (span && trace)
          trace.finish(
            span,
            controller.signal.aborted ? 'cancelled' : 'failed',
            controller.signal.aborted ? {} : { error: 'compaction_error' }
          )
        detach()
        // 준비 실패는 실제 생성에 영향을 주지 않습니다. 필요해지면 동기 축약으로 재시도합니다.
        if (this.preparations.get(input.threadId) === entry) this.preparations.delete(input.threadId)
        return undefined
      }
    )
  }

  async *streamWithRetry(
    request: LLMRequest,
    maxInputTokens: number,
    signal: AbortSignal,
    trace: TraceRecorder
  ): AsyncGenerator<LLMEvent> {
    let emitted = false
    try {
      for await (const event of tracedModelStream(
        this.llm.stream(request, { signal }),
        request.model,
        trace,
        trace.root.spanId,
        signal
      )) {
        signal.throwIfAborted()
        if (!(event.type === EventType.CUSTOM && (event.name === TRACE_EVENT || event.name === LLM_USAGE_EVENT)))
          emitted = true
        yield event
      }
    } catch (error) {
      signal.throwIfAborted()
      if (emitted || !isContextOverflow(error)) throw error
      const fitted = await this.fitInput(request.input, maxInputTokens, signal, true, signal, trace)
      signal.throwIfAborted()
      yield* tracedModelStream(
        this.llm.stream({ ...request, input: fitted.input }, { signal }),
        request.model,
        trace,
        trace.root.spanId,
        signal
      )
    }
  }

  async fitInput(
    input: RunAgentInput,
    maxInputTokens: number,
    signal: AbortSignal,
    force = false,
    backgroundSignal = signal,
    trace?: TraceRecorder
  ): Promise<{ input: RunAgentInput; compaction?: CompactionResult }> {
    signal.throwIfAborted()
    const countTokens = async (candidate: RunAgentInput) => {
      const count = await this.llm.countTokens(
        {
          input: candidate,
          model: this.config.model,
          maxOutputTokens: this.config.maxOutputTokens,
          ...(this.config.webSearch === undefined ? {} : { webSearch: this.config.webSearch }),
          ...(this.config.reasoning === undefined ? {} : { reasoning: this.config.reasoning })
        },
        { signal }
      )
      signal.throwIfAborted()
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid input token count')
      return count
    }

    const count = await countTokens(input)
    const entry = this.preparations.get(input.threadId)
    if (entry && matchesPrepared(entry, input)) {
      if (count > maxInputTokens || force) await waitForPreparation(entry.task, signal)
      signal.throwIfAborted()
      const ready = applyPrepared(entry, input)
      if (entry.result && !ready) this.discardPreparation(input.threadId, entry)
      if (ready) {
        const candidate = { ...input, messages: ready.messages }
        const tokens = await countTokens(candidate)
        this.discardPreparation(input.threadId, entry)
        if (tokens <= maxInputTokens && tokens < count) return { input: candidate, compaction: ready }
      }
    } else if (entry) this.discardPreparation(input.threadId, entry)
    if (!force && count <= maxInputTokens) {
      const policy = this.policy
      if (
        count >= maxInputTokens * (policy.threshold ?? 0.8) &&
        input.messages.length > (policy.keepRecentMessages ?? 6) &&
        input.messages.filter((message) => message.role === 'user' && !message.id.startsWith(CONTEXT_MESSAGE_PREFIX))
          .length > 1
      )
        this.prepareCompaction(input, maxInputTokens, count, backgroundSignal, trace)
      return { input }
    }

    const compactionSpan = trace?.start('compaction', 'compact', trace.root.spanId)
    let compaction: CompactionResult
    const compactionLLM =
      compactionSpan && trace ? tracedCompactionLLM(this.llm, trace, compactionSpan.spanId, signal) : this.llm
    try {
      compaction = await compact(
        compactionLLM,
        { input, model: this.config.model, maxInputTokens },
        { ...this.policy, signal, inputTokens: count, force }
      )
    } catch (error) {
      if (compactionSpan && trace) {
        trace.finish(
          compactionSpan,
          signal.aborted ? 'cancelled' : 'failed',
          signal.aborted ? {} : { error: 'compaction_error' }
        )
      }
      throw error
    }
    if (compactionSpan && trace) trace.finish(compactionSpan, 'completed')
    signal.throwIfAborted()
    const compacted = { ...input, messages: compaction.messages }
    // 축약기의 기본 계산과 달리 네이티브 검색 도구의 입력 비용까지 포함해 다시 검사합니다.
    if (
      (this.config.webSearch !== undefined || this.config.reasoning !== undefined) &&
      (await countTokens(compacted)) > maxInputTokens
    )
      throw new Error('compacted input exceeds the model input budget')
    return { input: compacted, compaction }
  }
}
