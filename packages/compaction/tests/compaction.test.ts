import { getEventListeners } from 'node:events'

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

test('summarizes old messages while preserving instructions, recent input and the original request', async (t) => {
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

test('returns unmodified messages without generating a summary when already within budget', async (t) => {
  const { compact, requests } = await setup(t)
  expect(await compact(input, 10000)).toStrictEqual({ messages: input.messages, summary: '', sourceMessageIds: [] })
  expect(requests).toHaveLength(0)
})

test('summarizes oversized history in bounded chunks and carries the previous summary forward', async (t) => {
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

test('preserves an entire recent tool exchange', async (t) => {
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

test('rejects an oversized preserved turn before calling the model', async (t) => {
  const { compact, requests } = await setup(t)
  await expect(
    compact({
      ...input,
      messages: [...input.messages.slice(0, -1), { id: 'recent', role: 'user', content: 'x'.repeat(1000) }]
    })
  ).rejects.toThrow('preserved messages')
  expect(requests).toHaveLength(0)
})

test('rejects history that cannot fit even one summary request', async (t) => {
  const { compact, requests } = await setup(t, { contextWindow: 800 })
  await expect(compact()).rejects.toThrow('summarization input budget')
  expect(requests).toHaveLength(0)
})

test('rejects output that still exceeds the final budget', async (t) => {
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

test('rejects incomplete or empty summary streams', async (t) => {
  const { compact } = await setup(t, {
    stream: async function* () {
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'summary', role: 'assistant' }
    }
  })
  await expect(compact()).rejects.toThrow('without completed text')
})

test('propagates provider failures', async (t) => {
  const { compact } = await setup(t, {
    stream: () => {
      throw new Error('provider unavailable')
    }
  })
  await expect(compact()).rejects.toThrow('provider unavailable')
})

for (const mode of ['external']) {
  test(`cancels an active summary via ${mode} and removes external listeners`, async (t) => {
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
    const assertion = expect(pending).rejects.toThrow(mode === 'external' ? 'user cancelled' : 'disposed')
    await ready
    controller.abort(new Error('user cancelled'))
    await assertion
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
}

test('rejects already cancelled requests without invoking the provider', async (t) => {
  const { compact, requests } = await setup(t)
  await expect(compact(input, 700, { signal: globalThis.AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow(
    'cancelled'
  )
  expect(requests).toHaveLength(0)
})

test('validates configuration', async () => {
  for (const value of [{ keepRecentMessages: 0 }, { maxSummaryTokens: -1 }, null, []]) {
    expect((await SummaryCompactionConfigSchema['~standard'].validate(value)).issues).toBeDefined()
  }
})
