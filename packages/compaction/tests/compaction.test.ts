import {
  compact as compactMessages,
  SummaryCompactionConfigSchema,
  type SummaryCompactionConfig
} from '@keundal/compaction'
import { EventType, type LLMEvent, type LLMRequest, type ExecutionOptions, type RunAgentInput } from '@keundal/core'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: { untouched: true },
  tools: [],
  context: [],
  messages: [
    { id: 'system', role: 'system', content: 'Keep this instruction' },
    { id: 'old-user', role: 'user', content: 'old question '.repeat(100) },
    { id: 'old-assistant', role: 'assistant', content: 'old answer '.repeat(100) },
    { id: 'recent', role: 'user', content: 'continue' }
  ]
}

async function* response(): AsyncIterable<LLMEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: 'summary', role: 'assistant' }
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'summary', delta: 'Earlier facts.' }
  yield { type: EventType.TEXT_MESSAGE_END, messageId: 'summary' }
}

async function setup(
  _t: TestContext,
  overrides: {
    contextWindow?: number
    stream?: (request: LLMRequest, options?: ExecutionOptions) => AsyncIterable<LLMEvent>
    count?: (request: LLMRequest) => number
    config?: SummaryCompactionConfig
  } = {}
) {
  const requests: LLMRequest[] = []
  class LLM {
    async getModel() {
      return { contextWindow: overrides.contextWindow ?? 10000, maxOutputTokens: 1000 }
    }
    async countTokens(request: LLMRequest) {
      return overrides.count?.(request) ?? JSON.stringify(request.input).length
    }
    stream(request: LLMRequest, options?: ExecutionOptions) {
      requests.push(request)
      return overrides.stream?.(request, options) ?? response()
    }
  }
  const llm = new LLM()
  const compact = (data = input, budget = 700, options?: ExecutionOptions) =>
    compactMessages(
      llm,
      { input: data, model: 'test', maxInputTokens: budget },
      {
        keepRecentMessages: 1,
        maxSummaryTokens: 100,
        ...overrides.config,
        ...options
      }
    )
  return { requests, compact }
}

test('이전 메시지를 요약하고 지침, 최근 입력, 원본 요청을 보존한다', async (t) => {
  const { compact, requests } = await setup(t)
  const original = globalThis.structuredClone(input)
  const result = await compact()
  expect(input).toStrictEqual(original)
  expect(result.sourceMessageIds).toStrictEqual(['old-user', 'old-assistant'])
  expect(result.summary).toBe('Earlier facts.')
  expect(result.messages[0]).toStrictEqual(input.messages[0])
  expect(result.messages.at(-1)).toStrictEqual(input.messages.at(-1))
  expect(result.messages[1].role).toBe('user')
  expect(JSON.stringify({ ...input, messages: result.messages }).length).toBeLessThanOrEqual(700)
  expect(requests).toHaveLength(1)
  expect(requests[0].input.tools).toStrictEqual([])
  expect(requests[0].input.state).toStrictEqual({})
})

test('입력이 예산 이내이면 요약을 생성하지 않고 기존 메시지를 반환한다', async (t) => {
  const { compact, requests } = await setup(t)
  expect(await compact(input, 10000)).toStrictEqual({ messages: input.messages, summary: '', sourceMessageIds: [] })
  expect(requests).toHaveLength(0)
})

test('한도를 넘는 이력을 예산에 맞게 나누어 요약하고 이전 요약을 다음 요청에 전달한다', async (t) => {
  const { compact, requests } = await setup(t, { contextWindow: 2400 })
  await compact()
  expect(requests).toHaveLength(2)
  for (const request of requests)
    expect(JSON.stringify(request.input).length + request.maxOutputTokens).toBeLessThanOrEqual(2400)
  const message = requests[1].input.messages[1]
  expect(
    'content' in message && typeof message.content === 'string' && JSON.parse(message.content).previousSummary
  ).toBe('Earlier facts.')
})

test('최근 사용자 턴의 도구 호출과 결과를 함께 보존한다', async (t) => {
  const { compact } = await setup(t)
  const data: RunAgentInput = {
    ...input,
    messages: [
      ...input.messages,
      {
        id: 'call',
        role: 'assistant',
        toolCalls: [{ id: 'tool-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]
      },
      { id: 'result', role: 'tool', toolCallId: 'tool-1', content: 'found' }
    ]
  }
  const result = await compact(data, 1000)
  expect(result.messages.slice(-3)).toStrictEqual(data.messages.slice(-3))
  expect(result.sourceMessageIds).toStrictEqual(['old-user', 'old-assistant'])
})

test('사용자 턴을 가로지르는 도구 호출부터 결과까지 원래 순서로 보존한다', async (t) => {
  const { compact, requests } = await setup(t)
  const retained: RunAgentInput['messages'] = [
    { id: 'lookup-request', role: 'user', content: 'Look up the result' },
    {
      id: 'lookup-call',
      role: 'assistant',
      toolCalls: [{ id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{"key":"a"}' } }]
    },
    { id: 'follow-up', role: 'user', content: 'Include the source' },
    { id: 'lookup-result', role: 'tool', toolCallId: 'lookup-1', content: 'Found a at source b' }
  ]
  const result = await compact({ ...input, messages: [...input.messages.slice(0, -1), ...retained] }, 1200)

  expect(result.messages.slice(2)).toStrictEqual(retained)
  expect(result.sourceMessageIds).toStrictEqual(['old-user', 'old-assistant'])
  const history = requests[0].input.messages[1]
  if (history.role !== 'user' || typeof history.content !== 'string') throw new Error('expected summary history')
  expect(JSON.parse(history.content).messages).toStrictEqual([input.messages[1], input.messages[2]])
})

test('보존할 대화가 예산을 넘으면 모델을 호출하기 전에 거부한다', async (t) => {
  const { compact, requests } = await setup(t)
  await expect(
    compact({
      ...input,
      messages: [...input.messages.slice(0, -1), { id: 'recent', role: 'user', content: 'x'.repeat(1000) }]
    })
  ).rejects.toThrow('preserved messages')
  expect(requests).toHaveLength(0)
})

test('요약 요청 하나에도 담을 수 없는 이력은 거부한다', async (t) => {
  const { compact, requests } = await setup(t, { contextWindow: 800 })
  await expect(compact()).rejects.toThrow('summarization input budget')
  expect(requests).toHaveLength(0)
})

test('축약 결과가 최종 입력 예산을 넘으면 거부한다', async (t) => {
  const { compact } = await setup(t, {
    count: (request) =>
      request.input.messages.some(
        (message) =>
          'content' in message &&
          typeof message.content === 'string' &&
          message.content.startsWith('Summary of earlier')
      )
        ? 9999
        : JSON.stringify(request.input).length
  })
  await expect(compact()).rejects.toThrow('compacted input still exceeds')
})

test('시작 이벤트만 전달하고 종료된 요약 스트림을 거부한다', async (t) => {
  const { compact } = await setup(t, {
    stream: async function* () {
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'summary', role: 'assistant' }
    }
  })
  await expect(compact()).rejects.toThrow('without completed text')
})

const summaryStart: LLMEvent = { type: EventType.TEXT_MESSAGE_START, messageId: 'summary', role: 'assistant' }
const summaryContent: LLMEvent = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'summary', delta: 'Earlier facts.' }
const summaryEnd: LLMEvent = { type: EventType.TEXT_MESSAGE_END, messageId: 'summary' }

test.for([
  {
    condition: '시작 전 내용',
    events: [summaryContent, summaryStart, summaryEnd],
    error: 'invalid summary text stream'
  },
  {
    condition: '시작 전 종료',
    events: [summaryEnd, summaryStart, summaryContent],
    error: 'invalid summary text stream'
  },
  {
    condition: '다른 메시지 ID의 내용',
    events: [summaryStart, { ...summaryContent, messageId: 'other' }, summaryEnd],
    error: 'invalid summary text stream'
  },
  {
    condition: '다른 메시지 ID의 종료',
    events: [summaryStart, summaryContent, { ...summaryEnd, messageId: 'other' }],
    error: 'invalid summary text stream'
  },
  {
    condition: '종료 후 내용',
    events: [summaryStart, summaryContent, summaryEnd, summaryContent],
    error: 'invalid summary text stream'
  },
  {
    condition: '중복 종료',
    events: [summaryStart, summaryContent, summaryEnd, summaryEnd],
    error: 'invalid summary text stream'
  },
  {
    condition: '두 번째 시작',
    events: [summaryStart, summaryContent, { ...summaryStart, messageId: 'other' }, summaryEnd],
    error: 'summary must contain a single text message'
  }
])('잘못된 요약 이벤트를 거부한다: $condition', async ({ events, error }, t) => {
  const { compact } = await setup(t, {
    stream: async function* () {
      yield* events
    }
  })
  await expect(compact()).rejects.toThrow(error)
})

test.for([
  { condition: '내용 이벤트가 없음', events: [summaryStart, summaryEnd] },
  { condition: '공백만 있음', events: [summaryStart, { ...summaryContent, delta: ' \t\n ' }, summaryEnd] }
])('정상 종료되어도 빈 요약을 거부한다: $condition', async ({ events }, t) => {
  const { compact } = await setup(t, {
    stream: async function* () {
      yield* events
    }
  })
  await expect(compact()).rejects.toThrow('summary stream ended without completed text')
})

test('공급자 오류를 호출자에게 전달한다', async (t) => {
  const { compact } = await setup(t, {
    stream: () => {
      throw new Error('provider unavailable')
    }
  })
  await expect(compact()).rejects.toThrow('provider unavailable')
})

test('외부 취소 신호로 진행 중인 요약을 중단한다', async (t) => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const { compact } = await setup(t, {
    stream: async function* (_request, options) {
      started()
      await new Promise<void>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })
      })
      yield* response()
    }
  })
  const controller = new globalThis.AbortController()
  const pending = compact(input, 700, { signal: controller.signal })
  const assertion = expect(pending).rejects.toThrow('user cancelled')
  await ready
  controller.abort(new Error('user cancelled'))
  await assertion
})

test('이미 취소된 요청은 공급자를 호출하지 않고 거부한다', async (t) => {
  const { compact, requests } = await setup(t)
  await expect(compact(input, 700, { signal: globalThis.AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow(
    'cancelled'
  )
  expect(requests).toHaveLength(0)
})

test('잘못된 축약 설정을 거부한다', async () => {
  for (const value of [{ keepRecentMessages: 0 }, { maxSummaryTokens: -1 }, null, []]) {
    expect((await SummaryCompactionConfigSchema['~standard'].validate(value)).issues).toBeDefined()
  }
})
