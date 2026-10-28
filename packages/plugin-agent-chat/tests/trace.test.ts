import type { AgentConfig } from '@keundal/agent-loop'
import { EventType } from '@keundal/core'
import type { AGUIEvent, RunAgentInput } from '@keundal/core'
import { LLMService } from '@keundal/llm'
import type { LLMEvent, LLMRequest } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { TOOL_APPROVAL_EVENT } from '@keundal/tool-approval'
import type { ToolExecutionContext } from '@keundal/tools'
import { LLM_USAGE_EVENT, TRACE_EVENT, llmUsageEvent, readTraceSpans, summarizeTrace } from '@keundal/trace'
import { Context } from 'cordis'
import { expect, test } from 'vitest'
import type { TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'trace-thread',
  runId: 'trace-run',
  state: { apiKey: 'private-api-key' },
  context: [],
  tools: [],
  messages: [{ id: 'question', role: 'user', content: 'Use both tools' }]
}

async function setup(
  t: TestContext,
  stream: (request: LLMRequest) => AsyncIterable<LLMEvent>,
  config: Partial<AgentConfig> = {},
  countTokens: (request: LLMRequest) => number = () => 10
) {
  const ctx = new Context()
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 1000, maxOutputTokens: 100 }
    }
    async countTokens(request: LLMRequest) {
      return countTokens(request)
    }
    stream(request: LLMRequest) {
      return stream(request)
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(agentPlugin, { model: 'trace-model', maxOutputTokens: 100, ...config })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })
  return ctx
}

function* text(id: string, content: string): Generator<LLMEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' }
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: content }
  yield { type: EventType.TEXT_MESSAGE_END, messageId: id }
}

function* call(id: string, name: string): Generator<LLMEvent> {
  yield { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name }
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: '{"value":"private-argument"}' }
  yield { type: EventType.TOOL_CALL_END, toolCallId: id }
}

test.for([false, true])(
  '도구 병렬 실행=%s에서도 Trace 계층과 원본 이벤트 순서 및 Journal을 유지한다',
  async (parallel, t) => {
    let round = 0
    const contexts: ToolExecutionContext[] = []
    const original: LLMEvent[] = []
    const ctx = await setup(
      t,
      async function* () {
        const events =
          round++ === 0
            ? [
                ...call('first-call', 'first'),
                ...call('second-call', 'second'),
                llmUsageEvent({
                  source: 'provider',
                  inputTokens: 100,
                  outputTokens: 2,
                  cacheReadTokens: 40,
                  cacheWriteTokens: 2
                }),
                llmUsageEvent({
                  source: 'provider',
                  inputTokens: 100,
                  outputTokens: 5,
                  cacheReadTokens: 40,
                  cacheWriteTokens: 2,
                  cost: { currency: 'USD', amount: 0.01, source: 'provider' }
                })
              ]
            : [
                ...text('answer', 'complete'),
                llmUsageEvent({
                  source: 'provider',
                  inputTokens: 150,
                  outputTokens: 10,
                  cacheReadTokens: 60,
                  cacheWriteTokens: 3,
                  cost: { currency: 'USD', amount: 0.02, source: 'provider' }
                })
              ]
        original.push(...events)
        yield* events
      },
      {
        parallelTools: parallel,
        tools: ['first', 'second'].map((name) => ({
          name,
          description: name,
          parameters: { type: 'object' },
          execute: (_args, context) => {
            contexts.push(context)
            return 'private-result'
          }
        }))
      }
    )
    const events: AGUIEvent[] = []
    for await (const event of ctx.agent.run(input)) events.push(event)
    const saved = await ctx.generation.get(input.runId)
    expect(saved?.status).toBe('completed')
    expect(saved?.journal.map((entry) => entry.event)).toEqual(events)
    const spans = readTraceSpans(
      saved!.journal.map((entry) => entry.event),
      input.runId
    )
    expect(spans.map((span) => span.kind)).toEqual(['agent', 'model', 'tool', 'tool', 'model'])
    expect(spans.map((span) => span.sequence)).toEqual([0, 1, 2, 3, 4])
    const [root, firstModel, firstTool, secondTool, finalModel] = spans
    expect(firstModel?.parentSpanId).toBe(root?.spanId)
    expect(finalModel?.parentSpanId).toBe(root?.spanId)
    expect(firstTool?.parentSpanId).toBe(firstModel?.spanId)
    expect(secondTool?.parentSpanId).toBe(firstModel?.spanId)
    expect([firstTool?.toolCallId, secondTool?.toolCallId]).toEqual(['first-call', 'second-call'])
    expect(contexts.map((context) => [context.traceId, context.parentSpanId])).toEqual([
      [root?.traceId, firstTool?.spanId],
      [root?.traceId, secondTool?.spanId]
    ])
    for (const span of spans) {
      expect(span.status).toBe('completed')
      expect(span.endedAt).toBeGreaterThanOrEqual(span.startedAt)
      const updates = events.flatMap((event) =>
        event.type === EventType.CUSTOM && event.name === TRACE_EVENT && event.value.span.spanId === span.spanId
          ? [event.value.span]
          : []
      )
      expect(updates[0].status).toBe('running')
      expect(updates.at(-1).status).toBe('completed')
      expect(new Set(updates.map((update) => update.sequence))).toEqual(new Set([span.sequence]))
    }
    const providerEvents = events.filter(
      (event) =>
        event.type !== EventType.RUN_STARTED &&
        event.type !== EventType.RUN_FINISHED &&
        event.type !== EventType.TOOL_CALL_RESULT &&
        !(event.type === EventType.CUSTOM && (event.name === TRACE_EVENT || event.name === TOOL_APPROVAL_EVENT))
    )
    expect(providerEvents).toEqual(original)
    expect(
      events.filter((event) => event.type === EventType.TOOL_CALL_RESULT).map((event) => event.toolCallId)
    ).toEqual(['first-call', 'second-call'])
    const total = summarizeTrace(spans)
    expect(total).toMatchObject({
      inputTokens: 250,
      outputTokens: 15,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
      usageSource: 'provider',
      cost: { complete: true, currency: 'USD' }
    })
    expect(total.cost?.amount).toBeCloseTo(0.03)
    const traceJSON = JSON.stringify(
      events.filter((event) => event.type === EventType.CUSTOM && event.name === TRACE_EVENT)
    )
    expect(traceJSON).not.toContain('private-api-key')
    expect(traceJSON).not.toContain('private-argument')
    expect(traceJSON).not.toContain('private-result')
  }
)

test('동기 Compaction의 요약 모델 호출을 하위 단계로 저장하고 각 사용량을 한 번만 집계한다', async (t) => {
  const requests: { summary: boolean }[] = []
  const ctx = await setup(
    t,
    async function* (request) {
      const summary = request.input.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.startsWith('Summarize the conversation data')
      )
      requests.push({ summary })
      yield* text(`message-${requests.length}`, summary ? 'saved summary' : 'final answer')
      yield llmUsageEvent({ source: 'provider', inputTokens: 20, outputTokens: 3, cacheReadTokens: 4 })
    },
    { compaction: { keepRecentMessages: 1, maxSummaryTokens: 30 } },
    (request) =>
      request.input.messages.reduce(
        (sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0),
        0
      )
  )
  const history: RunAgentInput = {
    ...input,
    runId: 'compaction-trace',
    messages: Array.from({ length: 11 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: 'x'.repeat(200)
    }))
  }
  const events: AGUIEvent[] = []
  for await (const event of ctx.agent.run(history)) events.push(event)
  const saved = await ctx.generation.get(history.runId)
  expect(saved?.status).toBe('completed')
  const spans = readTraceSpans(
    saved!.journal.map((entry) => entry.event),
    history.runId
  )
  const compaction = spans.find((span) => span.kind === 'compaction')
  const models = spans.filter((span) => span.kind === 'model')
  const summaryCalls = requests.filter((request) => request.summary).length
  expect(summaryCalls).toBeGreaterThan(0)
  expect(models).toHaveLength(requests.length)
  expect(models.filter((span) => span.parentSpanId === compaction?.spanId)).toHaveLength(summaryCalls)
  expect(compaction?.status).toBe('completed')
  expect(summarizeTrace(spans)).toMatchObject({
    inputTokens: requests.length * 20,
    outputTokens: requests.length * 3,
    cacheReadTokens: requests.length * 4
  })
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
})

test('Trace 메타데이터를 먼저 전달해도 본문 전 컨텍스트 초과는 한 번 축약한 뒤 재시도한다', async (t) => {
  let attempts = 0
  let summaries = 0
  const ctx = await setup(
    t,
    async function* (request) {
      const summary = request.input.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.startsWith('Summarize the conversation data')
      )
      if (summary) {
        summaries++
        yield* text(`summary-${summaries}`, 'saved context')
        return
      }
      if (attempts++ === 0) {
        yield llmUsageEvent({ source: 'provider', inputTokens: 7 })
        throw Object.assign(new Error('private-provider-error'), { code: 'context_length_exceeded' })
      }
      yield* text('retry-answer', 'recovered')
    },
    { compaction: { keepRecentMessages: 1, maxSummaryTokens: 30 } },
    (request) =>
      request.input.messages.reduce(
        (sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0),
        0
      )
  )
  const events: AGUIEvent[] = []
  for await (const event of ctx.agent.run({
    ...input,
    runId: 'retry-trace',
    messages: [
      { id: 'old-user', role: 'user', content: 'old question' },
      { id: 'old-answer', role: 'assistant', content: 'old answer' },
      { id: 'new-user', role: 'user', content: 'new question' }
    ]
  }))
    events.push(event)
  expect(attempts).toBe(2)
  expect(summaries).toBe(1)
  expect(events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => event.delta)).toEqual([
    'recovered'
  ])
  const snapshot = await ctx.generation.get('retry-trace')
  const spans = readTraceSpans(
    snapshot!.journal.map((entry) => entry.event),
    'retry-trace'
  )
  expect(snapshot?.status).toBe('completed')
  expect(spans.filter((span) => span.kind === 'model' && span.status === 'failed').map((span) => span.error)).toEqual([
    'context_overflow'
  ])
  expect(JSON.stringify(spans)).not.toContain('private-provider-error')
  expect(events.filter((event) => event.type === EventType.CUSTOM && event.name === LLM_USAGE_EVENT)).toEqual([
    { type: EventType.CUSTOM, name: LLM_USAGE_EVENT, value: { source: 'provider', inputTokens: 7 } }
  ])
})
