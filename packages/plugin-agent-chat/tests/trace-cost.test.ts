import { AgentConfigSchema, parseAgentConfig, type AgentConfig } from '@keundal/agent-loop'
import {
  EventType,
  LLMService,
  TRACE_EVENT,
  llmUsageEvent,
  readTraceSpans,
  summarizeTrace,
  type LLMEvent,
  type LLMRequest,
  type RunAgentInput,
  type TraceSpan
} from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test } from 'vitest'
import type { TestContext } from 'vitest'

const pricing = {
  currency: 'USD',
  models: {
    'priced-model': {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75
    }
  }
} satisfies NonNullable<AgentConfig['pricing']>

const echoTool = {
  name: 'echo',
  description: 'Return a fixed value',
  parameters: { type: 'object' },
  execute: () => 'ok'
}

function runInput(runId: string): RunAgentInput {
  return {
    threadId: `${runId}-thread`,
    runId,
    state: {},
    context: [],
    tools: [],
    messages: [{ id: 'question', role: 'user', content: 'answer' }]
  }
}

function* text(id: string, content: string): Generator<LLMEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' }
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: content }
  yield { type: EventType.TEXT_MESSAGE_END, messageId: id }
}

function* call(id: string, name: string): Generator<LLMEvent> {
  yield { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name }
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: '{}' }
  yield { type: EventType.TOOL_CALL_END, toolCallId: id }
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
  const agent = await ctx.plugin(agentPlugin, { model: 'priced-model', maxOutputTokens: 100, ...config })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })
  return ctx
}

async function run(ctx: Context, input: RunAgentInput): Promise<TraceSpan[]> {
  for await (const event of ctx.agent.run(input)) void event
  const saved = await ctx.generation.get(input.runId)
  expect(saved?.status).toBe('completed')
  return readTraceSpans(saved!.journal.map((entry) => entry.event))
}

test('가격표에 있는 모델은 입력과 출력 토큰으로 계산한 비용을 estimate로 기록한다', async (t) => {
  const ctx = await setup(
    t,
    async function* () {
      yield* text('answer', 'done')
      yield llmUsageEvent({ source: 'provider', inputTokens: 1000, outputTokens: 200 })
    },
    { pricing }
  )
  const spans = await run(ctx, runInput('cost-basic'))
  const model = spans.find((span) => span.kind === 'model')!
  expect(model.cost).toEqual({ currency: 'USD', amount: expect.closeTo(0.006, 9), source: 'estimate' })
  expect(summarizeTrace(spans).cost).toMatchObject({ currency: 'USD', complete: true, source: 'estimate' })
  expect(summarizeTrace(spans).cost?.amount).toBeCloseTo(0.006, 9)
})

test('공급자가 비용을 주면 가격표 추정으로 덮어쓰지 않는다', async (t) => {
  const ctx = await setup(
    t,
    async function* () {
      yield* text('answer', 'done')
      yield llmUsageEvent({
        source: 'provider',
        inputTokens: 1000,
        outputTokens: 200,
        cost: { currency: 'EUR', amount: 0.5, source: 'provider' }
      })
    },
    { pricing }
  )
  const spans = await run(ctx, runInput('cost-provider'))
  expect(spans.find((span) => span.kind === 'model')?.cost).toEqual({
    currency: 'EUR',
    amount: 0.5,
    source: 'provider'
  })
  expect(summarizeTrace(spans).cost).toMatchObject({ currency: 'EUR', amount: 0.5, source: 'provider' })
})

test('같은 호출에서 비용 없는 사용량이 뒤에 와도 먼저 받은 공급자 비용을 유지한다', async (t) => {
  const ctx = await setup(
    t,
    async function* () {
      yield* text('answer', 'done')
      yield llmUsageEvent({
        source: 'provider',
        inputTokens: 10,
        cost: { currency: 'USD', amount: 0.25, source: 'provider' }
      })
      yield llmUsageEvent({ source: 'provider', inputTokens: 1000, outputTokens: 200 })
    },
    { pricing }
  )
  const spans = await run(ctx, runInput('cost-provider-first'))
  expect(spans.find((span) => span.kind === 'model')?.cost).toEqual({
    currency: 'USD',
    amount: 0.25,
    source: 'provider'
  })
})

test('캐시 읽기·쓰기 토큰은 총 입력에서 빼서 캐시 가격으로 한 번만 계산한다', async (t) => {
  const ctx = await setup(
    t,
    async function* () {
      yield* text('answer', 'done')
      yield llmUsageEvent({
        source: 'provider',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 400,
        cacheWriteTokens: 100
      })
    },
    { pricing }
  )
  const spans = await run(ctx, runInput('cost-cache'))
  // 일반 입력 500 × 3 + 캐시 읽기 400 × 0.3 + 캐시 쓰기 100 × 3.75 + 출력 200 × 15 (100만 토큰 기준)
  expect(spans.find((span) => span.kind === 'model')?.cost?.amount).toBeCloseTo(0.004995, 9)
})

test('캐시 가격을 생략하면 캐시 토큰에 입력 가격을 적용하고 두 번 더하지 않는다', async (t) => {
  const ctx = await setup(
    t,
    async function* () {
      yield* text('answer', 'done')
      yield llmUsageEvent({
        source: 'provider',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 400
      })
    },
    { pricing: { currency: 'USD', models: { 'priced-model': { inputPerMillion: 3, outputPerMillion: 15 } } } }
  )
  const spans = await run(ctx, runInput('cost-cache-default'))
  expect(spans.find((span) => span.kind === 'model')?.cost?.amount).toBeCloseTo(0.006, 9)
})

test.for([
  ['가격표에 없는 모델', { currency: 'USD', models: { other: { inputPerMillion: 1, outputPerMillion: 1 } } }],
  ['가격표를 설정하지 않은 에이전트', undefined]
] as const)('%s은 비용을 0으로 채우지 않고 미확정으로 둔다', async ([, table], t) => {
  const ctx = await setup(
    t,
    async function* () {
      yield* text('answer', 'done')
      yield llmUsageEvent({ source: 'provider', inputTokens: 1000, outputTokens: 200 })
    },
    table ? { pricing: table } : {}
  )
  const spans = await run(ctx, runInput('cost-unpriced'))
  const model = spans.find((span) => span.kind === 'model')!
  expect(model.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200 })
  expect(model).not.toHaveProperty('cost')
  expect(summarizeTrace(spans).cost).toBeUndefined()
})

test.for([
  ['출력 토큰이 없는 사용량', { inputTokens: 1000 }],
  ['입력 토큰이 없는 사용량', { outputTokens: 200 }],
  [
    '캐시 토큰이 총 입력보다 많은 모순된 사용량',
    { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 30 }
  ]
] as const)('%s은 추정하지 않고 비용을 미확정으로 둔다', async ([, usage], t) => {
  const ctx = await setup(
    t,
    async function* () {
      yield* text('answer', 'done')
      yield llmUsageEvent({ source: 'provider', ...usage })
    },
    { pricing }
  )
  const spans = await run(ctx, runInput('cost-insufficient'))
  expect(spans.find((span) => span.kind === 'model')).not.toHaveProperty('cost')
  expect(summarizeTrace(spans).cost).toBeUndefined()
})

test('사용량이 없는 모델 호출이 섞이면 전체 비용은 부분 집계로 표시한다', async (t) => {
  const ctx = await setup(
    t,
    async function* (request) {
      if (request.input.messages.some((message) => message.role === 'tool')) {
        yield* text('answer', 'done')
        return
      }
      yield* call('echo-call', 'echo')
      yield llmUsageEvent({ source: 'provider', inputTokens: 1000, outputTokens: 200 })
    },
    { pricing, tools: [echoTool] }
  )
  const spans = await run(ctx, runInput('cost-mixed'))
  expect(spans.filter((span) => span.kind === 'model')).toHaveLength(2)
  const cost = summarizeTrace(spans).cost
  expect(cost).toMatchObject({ currency: 'USD', complete: false, source: 'estimate' })
  expect(cost?.amount).toBeCloseTo(0.006, 9)
})

test('동기 Compaction의 요약 모델 호출에도 같은 가격표를 적용한다', async (t) => {
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
    { pricing, compaction: { keepRecentMessages: 1, maxSummaryTokens: 30 } },
    (request) =>
      request.input.messages.reduce(
        (sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0),
        0
      )
  )
  const input: RunAgentInput = {
    ...runInput('cost-compaction'),
    messages: Array.from({ length: 11 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: 'x'.repeat(200)
    }))
  }
  const spans = await run(ctx, input)
  const compaction = spans.find((span) => span.kind === 'compaction')!
  const summaryCalls = spans.filter((span) => span.kind === 'model' && span.parentSpanId === compaction.spanId)
  expect(summaryCalls.length).toBeGreaterThan(0)
  // 호출마다 일반 입력 16 × 3 + 캐시 읽기 4 × 0.3 + 출력 3 × 15 (100만 토큰 기준)
  const perCall = (16 * 3 + 4 * 0.3 + 3 * 15) / 1_000_000
  for (const span of summaryCalls) {
    expect(span.cost).toEqual({ currency: 'USD', amount: expect.closeTo(perCall, 12), source: 'estimate' })
  }
  const summary = summarizeTrace(spans)
  expect(summary.cost).toMatchObject({ complete: true, source: 'estimate' })
  expect(summary.cost?.amount).toBeCloseTo(requests.length * perCall, 12)
})

test('서브에이전트의 모델 호출도 같은 가격표로 추정해 부모 Trace에 한 번씩 합산한다', async (t) => {
  const ctx = await setup(
    t,
    async function* (request) {
      if (request.input.state.subagent) {
        yield* text('child-answer', 'child done')
        yield llmUsageEvent({ source: 'provider', inputTokens: 13, outputTokens: 1 })
        return
      }
      if (request.input.messages.some((message) => message.role === 'tool')) {
        yield* text('parent-answer', 'finished')
        yield llmUsageEvent({ source: 'provider', inputTokens: 200, outputTokens: 20 })
        return
      }
      yield { type: EventType.TOOL_CALL_START, toolCallId: 'delegate-call', toolCallName: 'delegate_task' }
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'delegate-call', delta: '{"task":"child work"}' }
      yield { type: EventType.TOOL_CALL_END, toolCallId: 'delegate-call' }
      yield llmUsageEvent({ source: 'provider', inputTokens: 100, outputTokens: 10 })
    },
    { pricing, subagents: true }
  )
  const input = runInput('cost-subagent')
  const spans = await run(ctx, input)
  const models = spans.filter((span) => span.kind === 'model')
  expect(models.filter((span) => span.runId !== input.runId)).toHaveLength(1)
  expect(models).toHaveLength(3)
  for (const span of models) expect(span.cost?.source).toBe('estimate')
  const summary = summarizeTrace(spans)
  // 입력 313 × 3 + 출력 31 × 15 (100만 토큰 기준)
  expect(summary.cost).toMatchObject({ currency: 'USD', complete: true, source: 'estimate' })
  expect(summary.cost?.amount).toBeCloseTo((313 * 3 + 31 * 15) / 1_000_000, 12)
})

test('가격표를 생략하면 기존 Trace 이벤트에 비용 필드를 추가하지 않는다', async (t) => {
  const ctx = await setup(t, async function* () {
    yield* text('answer', 'done')
    yield llmUsageEvent({ source: 'provider', inputTokens: 1000, outputTokens: 200 })
  })
  const input = runInput('cost-regression')
  for await (const event of ctx.agent.run(input)) void event
  const saved = await ctx.generation.get(input.runId)
  const traceEvents = saved!.journal
    .map((entry) => entry.event)
    .filter((event) => event.type === EventType.CUSTOM && event.name === TRACE_EVENT)
  expect(traceEvents.length).toBeGreaterThan(0)
  expect(JSON.stringify(traceEvents)).not.toContain('"cost"')
})

test('유효한 가격표는 설정 검증을 통과하고 모델 ID를 프로토타입 속성과 구분한다', async () => {
  const parsed = parseAgentConfig({
    model: 'priced-model',
    maxOutputTokens: 100,
    pricing: {
      currency: ' KRW ',
      models: { constructor: { inputPerMillion: 0, outputPerMillion: 1.5 } }
    }
  })
  expect(parsed.pricing?.currency).toBe('KRW')
  expect(Object.hasOwn(parsed.pricing!.models, 'constructor')).toBe(true)
  expect(Object.hasOwn(parsed.pricing!.models, 'toString')).toBe(false)
  expect(parseAgentConfig({ model: 'priced-model', maxOutputTokens: 100 })).not.toHaveProperty('pricing')
})

test.for([
  ['통화가 없음', { models: {} }],
  ['빈 통화', { currency: ' ', models: {} }],
  ['models가 배열', { currency: 'USD', models: [] }],
  ['입력 가격이 없음', { currency: 'USD', models: { m: { outputPerMillion: 1 } } }],
  ['출력 가격이 없음', { currency: 'USD', models: { m: { inputPerMillion: 1 } } }],
  ['음수 가격', { currency: 'USD', models: { m: { inputPerMillion: -1, outputPerMillion: 1 } } }],
  ['유한하지 않은 가격', { currency: 'USD', models: { m: { inputPerMillion: Infinity, outputPerMillion: 1 } } }],
  ['문자열 가격', { currency: 'USD', models: { m: { inputPerMillion: '1', outputPerMillion: 1 } } }],
  [
    '오타가 있는 가격 필드',
    { currency: 'USD', models: { m: { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMilion: 1 } } }
  ],
  ['알 수 없는 최상위 필드', { currency: 'USD', models: {}, region: 'us' }],
  ['빈 모델 ID', { currency: 'USD', models: { ' ': { inputPerMillion: 1, outputPerMillion: 1 } } }]
] as const)('잘못된 가격표(%s)는 설정 검증에서 거부한다', async ([, invalid]) => {
  const result = await AgentConfigSchema['~standard'].validate({
    model: 'priced-model',
    maxOutputTokens: 100,
    pricing: invalid
  })
  expect(result.issues).toBeDefined()
})
