import { setImmediate } from 'node:timers/promises'

import { parseAgentConfig, type AgentConfig } from '@keundal/agent-loop'
import { EventType, type AGUIEvent, type ExecutionOptions, type RunAgentInput } from '@keundal/core'
import { LLMService, type LLMEvent, type LLMModel, type LLMRequest } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { readTraceSpans } from '@keundal/trace'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  messages: [{ id: 'question', role: 'user', content: 'hello' }],
  tools: [],
  context: [],
  state: {}
}
const transient = () => Object.assign(new Error('rate limited'), { status: 429 })
async function* answer(): AsyncIterable<LLMEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'recovered' }
  yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
}
async function collect(stream: AsyncIterable<AGUIEvent>) {
  const events: AGUIEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
async function setup(
  t: TestContext,
  stream: LLMService['stream'],
  config: Partial<AgentConfig> = {},
  models: Record<string, LLMModel> = {}
) {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel(model: string) {
      return models[model] ?? { contextWindow: 1000, maxOutputTokens: 100 }
    }
    async countTokens(request: LLMRequest) {
      return request.model === 'too-small' ? 980 : 20
    }
    async *stream(request: LLMRequest, options?: ExecutionOptions) {
      requests.push(request)
      yield* stream(request, options)
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(agentPlugin, {
    model: 'primary',
    maxOutputTokens: 100,
    retry: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
    ...config
  })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })
  return { ctx, requests, agent }
}

test.for([
  Object.assign(new Error('limited'), { status: 429 }),
  Object.assign(new Error('unavailable'), { status: 503 }),
  new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
])('응답 전 일시적 오류를 같은 실행에서 재시도하고 모델별 실행 추적을 남긴다: %s', async (error, t) => {
  let calls = 0
  const { ctx, requests } = await setup(t, async function* () {
    if (++calls < 3) throw error
    yield* answer()
  })
  const events = await collect(ctx.agent.run(input))
  expect(requests).toHaveLength(3)
  expect(events.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1)
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  const spans = readTraceSpans(events).filter((span) => span.kind === 'model')
  expect(spans.map((span) => span.status)).toEqual(['failed', 'failed', 'completed'])
  expect((await ctx.session.get('thread'))?.messages).toContainEqual(
    expect.objectContaining({ role: 'assistant', content: 'recovered' })
  )
})

test.for([false, { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 }] as const)(
  '재시도 비활성화와 횟수 제한을 지킨다: %s',
  async (retry, t) => {
    const { ctx, requests } = await setup(
      t,
      () => {
        throw transient()
      },
      { retry }
    )
    await expect(collect(ctx.agent.run(input))).rejects.toThrow('rate limited')
    expect(requests).toHaveLength(retry === false ? 1 : 2)
    expect((await ctx.generation.get('run'))?.status).toBe('failed')
  }
)

test.for([400, 401, 403, 404, 501])('HTTP %s 오류는 재시도하거나 대체 모델을 호출하지 않는다', async (status, t) => {
  const { ctx, requests } = await setup(
    t,
    () => {
      throw Object.assign(new Error('permanent'), { status })
    },
    { fallbackModels: ['secondary'] }
  )
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('permanent')
  expect(requests).toHaveLength(1)
})

test.for([
  { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' },
  { type: EventType.REASONING_MESSAGE_START, messageId: 'reasoning', role: 'reasoning' },
  { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'lookup' },
  { type: EventType.CUSTOM, name: 'keundal.source', value: { id: 'source', url: 'https://example.com' } }
] satisfies LLMEvent[])('응답 이벤트 %s 전달 뒤에는 재시도와 대체 모델 전환을 막는다', async (event, t) => {
  const { ctx, requests } = await setup(
    t,
    async function* () {
      yield event
      throw transient()
    },
    { fallbackModels: ['secondary'] }
  )
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('rate limited')
  expect(requests).toHaveLength(1)
})

test('완료된 도구를 재실행하지 않고 호환되는 대체 모델에 도구 결과를 전달한다', async (t) => {
  let executions = 0
  const { ctx, requests } = await setup(
    t,
    async function* (request) {
      if (request.model === 'secondary') {
        yield* answer()
        return
      }
      if (request.input.messages.some((message) => message.role === 'tool')) throw transient()
      yield { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'lookup' }
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '{}' }
      yield { type: EventType.TOOL_CALL_END, toolCallId: 'call' }
    },
    {
      fallbackModels: ['no-tools', 'no-reasoning', 'too-small', 'secondary'],
      reasoning: 'high',
      tools: [
        {
          name: 'lookup',
          description: 'lookup',
          parameters: { type: 'object' },
          execute: () => {
            executions++
            return 'saved result'
          }
        }
      ]
    },
    {
      'no-tools': { contextWindow: 1000, maxOutputTokens: 100, capabilities: { tools: false, reasoning: ['high'] } },
      'no-reasoning': { contextWindow: 1000, maxOutputTokens: 100, capabilities: { tools: true, reasoning: ['low'] } },
      'too-small': { contextWindow: 1000, maxOutputTokens: 100, capabilities: { tools: true, reasoning: ['high'] } },
      secondary: { contextWindow: 1000, maxOutputTokens: 100, capabilities: { tools: true, reasoning: ['high'] } }
    }
  )
  const events = await collect(ctx.agent.run(input))
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(executions).toBe(1)
  expect(requests.map((request) => request.model)).toEqual(['primary', 'primary', 'primary', 'primary', 'secondary'])
  expect(requests.at(-1)?.input.messages).toContainEqual(
    expect.objectContaining({ role: 'tool', toolCallId: 'call', content: 'saved result' })
  )
  expect(
    readTraceSpans(events)
      .filter((span) => span.kind === 'model')
      .at(-1)?.model
  ).toBe('secondary')
})

test('대체 모델 체인을 순서대로 시도하며 소진하면 마지막 오류를 전달한다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    (request) => {
      throw Object.assign(new Error(request.model), { status: 503 })
    },
    { retry: false, fallbackModels: ['secondary', 'last'] }
  )
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('last')
  expect(requests.map((request) => request.model)).toEqual(['primary', 'secondary', 'last'])
})

test('대체 모델의 서명 있는 도구 호출 후에도 선택한 모델과 서명을 유지한다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    async function* (request) {
      if (request.model === 'primary') throw transient()
      if (request.input.messages.some((message) => message.role === 'tool')) {
        expect(request.input.messages).toContainEqual(
          expect.objectContaining({
            role: 'assistant',
            toolCalls: [expect.objectContaining({ encryptedValue: 'secondary-signature' })]
          })
        )
        yield* answer()
        return
      }
      yield { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'lookup' }
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '{}' }
      yield {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: 'tool-call',
        entityId: 'call',
        encryptedValue: 'secondary-signature'
      }
      yield { type: EventType.TOOL_CALL_END, toolCallId: 'call' }
    },
    {
      retry: false,
      fallbackModels: ['secondary'],
      tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' }, execute: () => 'result' }]
    },
    { secondary: { contextWindow: 160, maxOutputTokens: 100, capabilities: { tools: true } } }
  )
  expect((await collect(ctx.agent.run(input))).at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(requests.map((request) => request.model)).toEqual(['primary', 'secondary', 'secondary'])
})

test.for([
  { config: { reasoning: 'high' as const }, limits: { contextWindow: 1000, maxOutputTokens: 100 } },
  {
    config: { webSearch: true },
    limits: { contextWindow: 1000, maxOutputTokens: 100, capabilities: { webSearch: false } }
  },
  { config: {}, limits: { contextWindow: 1000, maxOutputTokens: 99 } },
  {
    config: { compaction: { models: { secondary: { reserveTokens: 881 } } } },
    limits: { contextWindow: 1000, maxOutputTokens: 100 }
  }
])(
  '필요한 기능과 출력·입력 여유 한도를 만족하지 않는 대체 모델을 호출하지 않는다: %s',
  async ({ config, limits }, t) => {
    const { ctx, requests } = await setup(
      t,
      () => {
        throw transient()
      },
      { ...config, retry: false, fallbackModels: ['secondary'] },
      { secondary: limits }
    )
    await expect(collect(ctx.agent.run(input))).rejects.toThrow('rate limited')
    expect(requests).toHaveLength(1)
  }
)

test('모델 종속 서명이 있으면 다른 모델로 전환하지 않는다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    () => {
      throw transient()
    },
    { retry: false, fallbackModels: ['secondary'] }
  )
  await expect(
    collect(
      ctx.agent.run({
        ...input,
        messages: [
          ...input.messages,
          { id: 'signed', role: 'reasoning', content: 'thought', encryptedValue: 'opaque-signature' }
        ]
      })
    )
  ).rejects.toThrow('rate limited')
  expect(requests).toHaveLength(1)
})

test('서버가 지정한 대기 시간이 상한보다 길면 조기 재시도 없이 대체 모델을 사용한다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    async function* (request) {
      if (request.model === 'primary')
        throw Object.assign(transient(), { headers: new Headers({ 'retry-after': '120' }) })
      yield* answer()
    },
    { fallbackModels: ['secondary'] }
  )
  expect((await collect(ctx.agent.run(input))).at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(requests.map((request) => request.model)).toEqual(['primary', 'secondary'])
})

test.for(['abort', 'return', 'dispose'] as const)(
  '재시도 대기 중 %s하면 다음 호출과 대체 모델을 시작하지 않는다',
  async (mode, t) => {
    const failed = Promise.withResolvers<void>()
    const { ctx, requests, agent } = await setup(
      t,
      () => {
        failed.resolve()
        throw transient()
      },
      { retry: { initialDelayMs: 1000, maxDelayMs: 1000 }, fallbackModels: ['secondary'] }
    )
    const controller = new AbortController()
    const iterator = ctx.agent.run(input, { signal: controller.signal })
    const pending = collect(iterator)
    const assertion = expect(pending).rejects.toThrow()
    await failed.promise
    await setImmediate()
    if (mode === 'abort') controller.abort(new Error('cancelled'))
    else if (mode === 'return') await iterator.return!()
    else await agent.dispose()
    await assertion
    expect(requests).toHaveLength(1)
  }
)

test('실패한 시도도 실행 예산을 사용하며 예산 초과 시 대체 모델을 호출하지 않는다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    () => {
      throw transient()
    },
    { budget: { maxTokens: 120 }, fallbackModels: ['secondary'] }
  )
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('run budget exceeded')
  expect(requests).toHaveLength(1)
})

test('재시도 설정과 대체 모델 체인의 범위 및 중복을 검증한다', () => {
  expect(parseAgentConfig({ model: 'primary', maxOutputTokens: 100 }).retry).toEqual({
    maxRetries: 2,
    initialDelayMs: 250,
    maxDelayMs: 4000
  })
  for (const config of [
    { retry: { maxRetries: 6 } },
    { retry: { maxRetries: null } },
    { retry: { initialDelayMs: -1 } },
    { retry: { maxDelayMs: 60_001 } },
    { retry: { initialDelayMs: 2, maxDelayMs: 1 } },
    { retry: { typo: 1 } },
    { fallbackModels: ['a', ' a '] },
    { fallbackModels: [''] },
    { fallbackModels: Array(1) },
    { fallbackModels: Array.from({ length: 9 }, (_, i) => String(i)) }
  ]) {
    expect(() => parseAgentConfig({ model: 'primary', maxOutputTokens: 100, ...config })).toThrow()
  }
})
