import { EventType, parseAGUIEvent } from '@keundal/core'
import type { LLMEvent, LLMRequest } from '@keundal/llm'
import mockLLMPlugin, {
  MockLLMConfigSchema,
  MockLLMService,
  listMockModels,
  type MockLLMConfig
} from '@keundal/plugin-llm-mock'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const request: LLMRequest = {
  model: 'mock-text',
  maxOutputTokens: 100,
  input: {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    tools: [],
    messages: [{ id: 'user', role: 'user', content: '안녕 🌙' }]
  }
}

async function setup(t: TestContext, config: MockLLMConfig = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(mockLLMPlugin, config)
  t.onTestFinished(() => fiber.dispose())
  return { llm: ctx.llm as MockLLMService, fiber }
}

async function collect(stream: AsyncIterable<LLMEvent>) {
  const events: LLMEvent[] = []
  for await (const event of stream) {
    parseAGUIEvent(event)
    events.push(event)
  }
  return events
}

function text(events: LLMEvent[]) {
  return events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => event.delta)
    .join('')
}

test('지정한 응답을 순서대로 내보내고 요청 사본을 기록하며 소진되면 실패한다', async (t) => {
  const events: LLMEvent[] = [
    { type: EventType.TOOL_CALL_START, toolCallId: 'lookup-1', toolCallName: 'lookup' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'lookup-1', delta: '{"key":7}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'lookup-1' }
  ]
  const { llm } = await setup(t, { inputTokens: 37, responses: [{ text: '첫 번째 🌙 응답입니다. 12345' }, { events }] })
  const input = structuredClone(request)
  expect(await llm.countTokens(input)).toBe(37)
  expect(text(await collect(llm.stream(input)))).toBe('첫 번째 🌙 응답입니다. 12345')
  input.input.messages.length = 0
  expect(llm.requests[0]!.input.messages).toHaveLength(1)
  expect(await collect(llm.stream(request))).toEqual(events)
  await expect(collect(llm.stream(request))).rejects.toThrow('responses exhausted at call 3')
})

test('부분 응답 뒤의 오류와 빈 응답을 구분하고 세 번째 응답까지 진행한다', async (t) => {
  const { llm } = await setup(t, {
    responses: [{ text: 'partial', error: 'broken stream' }, { text: '' }, { error: 'offline' }]
  })
  const received: LLMEvent[] = []
  await expect(
    (async () => {
      for await (const event of llm.stream(request)) received.push(event)
    })()
  ).rejects.toThrow('broken stream')
  expect(text(received)).toBe('partial')
  expect(text(await collect(llm.stream(request)))).toBe('')
  await expect(collect(llm.stream(request))).rejects.toThrow('offline')
})

test.for(['signal', 'dispose', 'return'] as const)(
  '대기 중인 스트림을 %s로 중단하면 이벤트를 추가하지 않는다',
  async (mode, t) => {
    const { llm, fiber } = await setup(t, { responses: [{ text: 'never', delayMs: 60_000 }] })
    const controller = new AbortController()
    const stream = llm.stream(request, { signal: controller.signal })
    const pending = stream.next()
    const rejected = expect(pending).rejects.toThrow(
      mode === 'signal' ? 'cancelled' : mode === 'dispose' ? 'disposed' : 'stopped'
    )
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10))
    if (mode === 'signal') controller.abort(new Error('cancelled'))
    else if (mode === 'dispose') await fiber.dispose()
    else await stream.return!()
    await rejected
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  }
)

test('취소된 호출은 응답을 소비하지 않고 해제된 서비스는 새 요청을 거부한다', async (t) => {
  const { llm, fiber } = await setup(t, { responses: [{ text: 'first' }] })
  await expect(collect(llm.stream(request, { signal: AbortSignal.abort(new Error('cancelled')) }))).rejects.toThrow(
    'cancelled'
  )
  expect(llm.requests).toEqual([])
  expect(text(await collect(llm.stream(request)))).toBe('first')
  await fiber.dispose()
  await expect(llm.getModel('mock-text')).rejects.toThrow('disposed')
  await expect(llm.countTokens(request)).rejects.toThrow('disposed')
  await expect(collect(llm.stream(request))).rejects.toThrow('disposed')
})

test('모델 한도와 토큰 수를 재정의하고 잘못된 출력 예산은 응답을 소비하기 전에 거부한다', async (t) => {
  const { llm } = await setup(t, {
    models: { small: { contextWindow: 80, maxOutputTokens: 19 } },
    responses: [{ text: 'ok' }]
  })
  expect(await llm.getModel('small')).toMatchObject({ contextWindow: 80, maxOutputTokens: 19 })
  const small = { ...request, model: 'small', maxOutputTokens: 19 }
  expect(await llm.countTokens(small)).toBe(new TextEncoder().encode(JSON.stringify(request.input)).length)
  await expect(collect(llm.stream({ ...small, maxOutputTokens: 20 }))).rejects.toThrow('output budget')
  await expect(llm.getModel('unknown')).rejects.toThrow('not configured')
  expect(llm.requests).toEqual([])
  expect(text(await collect(llm.stream(small)))).toBe('ok')
})

test('기본 모델은 응답을 반복하고 오류 모델은 실패하며 명시한 도구만 호출한다', async (t) => {
  const { llm } = await setup(t)
  expect((await listMockModels()).map((model) => model.id)).toEqual([
    'mock-text',
    'mock-tool',
    'mock-error',
    'mock-slow'
  ])
  for (let i = 0; i < 2; i++) expect(text(await collect(llm.stream(request)))).toBe('Mock LLM: 안녕 🌙')
  const multipart = structuredClone(request)
  multipart.input.messages = [
    {
      id: 'user',
      role: 'user',
      content: [
        { type: 'text', text: '안녕 ' },
        { type: 'image', source: { type: 'url', value: 'https://example.com/image.png' } },
        { type: 'text', text: '🌙' }
      ]
    }
  ]
  expect(text(await collect(llm.stream(multipart)))).toBe('Mock LLM: 안녕 🌙')
  await expect(collect(llm.stream({ ...request, model: 'mock-error' }))).rejects.toThrow('simulated provider error')
  const toolRequest = structuredClone({ ...request, model: 'mock-tool' })
  toolRequest.input.tools.push({ name: 'lookup', description: 'lookup', parameters: { type: 'object' } })
  expect((await collect(llm.stream(toolRequest))).some((event) => event.type === EventType.TOOL_CALL_START)).toBe(false)
  toolRequest.input.messages = [{ id: 'user', role: 'user', content: '{"name":"lookup","arguments":{"key":7}}' }]
  const events = await collect(llm.stream(toolRequest))
  expect(events).toEqual([
    { type: EventType.TOOL_CALL_START, toolCallId: expect.any(String), toolCallName: 'lookup' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: expect.any(String), delta: '{"key":7}' },
    { type: EventType.TOOL_CALL_END, toolCallId: expect.any(String) }
  ])
  toolRequest.input.messages.push({ id: 'result', role: 'tool', toolCallId: 'call', content: 'found 7' })
  expect(text(await collect(llm.stream(toolRequest)))).toBe('Mock tool result: found 7')
  toolRequest.input.messages = [{ id: 'user-2', role: 'user', content: '{"name":"delete_files","arguments":{}}' }]
  expect((await collect(llm.stream(toolRequest))).some((event) => event.type === EventType.TOOL_CALL_START)).toBe(false)
})

test('실행 수명 이벤트와 잘못된 설정은 LLM 목업 설정에서 거부한다', () => {
  for (const config of [
    { responses: [{ events: [{ type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' }] }] },
    { responses: [{}] },
    { responses: [{ text: 'a', events: [] }] },
    { delayMs: -1 },
    { inputTokens: 1.5 },
    { models: {} },
    { models: { invalid: { contextWindow: 10, maxOutputTokens: 10 } } }
  ])
    expect(MockLLMConfigSchema.safeParse(config).success).toBe(false)
})
