import { setImmediate } from 'node:timers/promises'

import { parseAgentConfig, type AgentCompactionConfig } from '@keundal/agent-loop'
import {
  EventType,
  LLMService,
  type AGUIEvent,
  type ExecutionOptions,
  type LLMEvent,
  type LLMRequest,
  type RunAgentInput
} from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import type { ExecutableTool } from '@keundal/tools'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: {},
  tools: [],
  context: [],
  messages: [
    { id: 'old', role: 'user', content: 'old question' },
    { id: 'answer', role: 'assistant', content: 'old answer' },
    { id: 'recent', role: 'user', content: 'continue' }
  ]
}
const collect = async (stream: AsyncIterable<AGUIEvent>) => {
  const events: AGUIEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
async function* text(id: string, content: string): AsyncIterable<LLMEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' }
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: content }
  yield { type: EventType.TEXT_MESSAGE_END, messageId: id }
}
const overflow = () => Object.assign(new Error('context is full'), { code: 'context_length_exceeded' })

async function setup(
  t: TestContext,
  options: {
    compaction?: AgentCompactionConfig
    tokens?: number
    count?: (request: LLMRequest) => number
    summary?: (signal: AbortSignal) => Promise<void>
    stream?: (request: LLMRequest, options?: ExecutionOptions) => AsyncIterable<LLMEvent>
    tools?: readonly ExecutableTool[]
  } = {}
) {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  const summaries: LLMRequest[] = []
  const prepared = Promise.withResolvers<void>()
  class LLM extends LLMService {
    constructor(ctx: Context) {
      super(ctx)
    }
    async getModel() {
      return { contextWindow: 1000, maxOutputTokens: 100 }
    }
    async countTokens(request: LLMRequest) {
      const hasSummary = request.input.messages.some(
        (message) =>
          'content' in message &&
          typeof message.content === 'string' &&
          message.content.startsWith('Summary of earlier')
      )
      if (hasSummary) prepared.resolve()
      return (
        options.count?.(request) ??
        (request.input.messages.some((message) => message.id === 'old') ? (options.tokens ?? 800) : 100)
      )
    }
    async *stream(request: LLMRequest, execution?: ExecutionOptions): AsyncIterable<LLMEvent> {
      if (
        request.input.messages[0]?.role === 'system' &&
        String(request.input.messages[0].content).startsWith('Summarize the conversation')
      ) {
        summaries.push(request)
        await options.summary?.(execution!.signal!)
        yield* text('summary', 'Earlier facts.')
      } else {
        requests.push(request)
        yield* options.stream?.(request, execution) ?? text(`reply-${request.input.runId}`, 'response')
      }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(agentPlugin, {
    model: 'test',
    maxOutputTokens: 100,
    tools: options.tools,
    compaction: { keepRecentMessages: 1, maxSummaryTokens: 50, ...options.compaction }
  })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })
  await ctx.session.commit({
    threadId: input.threadId,
    expectedRevision: 0,
    messages: input.messages,
    state: input.state
  })
  return {
    ctx,
    requests,
    summaries,
    agent,
    prepared: async () => {
      await prepared.promise
      await setImmediate()
    }
  }
}

test('임계치에 도달하면 백그라운드 준비를 기다리지 않고 응답하며 추가 메시지를 보존한다', async (t) => {
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const { ctx, requests, summaries, prepared } = await setup(t, {
    summary: async () => {
      started.resolve()
      await gate.promise
    }
  })
  const events = await collect(ctx.agent.run(input))
  await started.promise
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(requests[0].input.messages).toStrictEqual(input.messages)
  expect(summaries).toHaveLength(1)
  gate.resolve()
  await prepared()
  const followup: RunAgentInput = {
    ...input,
    runId: 'next',
    messages: [...input.messages, { id: 'new', role: 'user', content: 'new question' }]
  }
  await collect(ctx.agent.run(followup))
  expect(requests[1].input.messages.some((message) => message.id === 'old')).toBe(false)
  expect(requests[1].input.messages.at(-1)).toStrictEqual(followup.messages.at(-1))
  expect((await ctx.generation.get('next'))?.request.compaction?.sourceMessageIds).toStrictEqual(['old', 'answer'])
})

test('같은 ID의 이력이 수정되면 오래된 요약을 적용하지 않는다', async (t) => {
  const { ctx, requests, prepared } = await setup(t)
  await collect(ctx.agent.run(input))
  await prepared()
  const changed = {
    ...input,
    runId: 'edited',
    messages: input.messages.map((message) =>
      message.id === 'old' && message.role === 'user' ? { ...message, content: 'corrected question' } : message
    )
  }
  await collect(ctx.agent.run(changed))
  expect(requests[1].input.messages).toContainEqual(changed.messages[0])
})

test('실제 컨텍스트 초과는 같은 실행 안에서 한 번 축약 후 재시도한다', async (t) => {
  let calls = 0
  const { ctx, summaries, requests } = await setup(t, {
    tokens: 500,
    stream: async function* () {
      if (++calls === 1) throw overflow()
      yield* text('final', 'done')
    }
  })
  const events = await collect(ctx.agent.run(input))
  expect(calls).toBe(2)
  expect(summaries).toHaveLength(1)
  expect(requests[1].input.messages.some((message) => message.id === 'old')).toBe(false)
  expect(events.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1)
  expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1)
  expect((await ctx.generation.get('run'))?.status).toBe('completed')
})

test('재시도도 실패하면 세 번째 생성을 시작하지 않는다', async (t) => {
  let calls = 0
  const { ctx, summaries } = await setup(t, {
    tokens: 500,
    stream: () => {
      calls++
      throw overflow()
    }
  })
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('context is full')
  expect(calls).toBe(2)
  expect(summaries).toHaveLength(1)
  expect((await ctx.generation.get('run'))?.status).toBe('failed')
})

test('부분 응답 전달 후 초과 오류가 발생하면 응답을 다시 생성하지 않는다', async (t) => {
  let calls = 0
  const { ctx, summaries } = await setup(t, {
    tokens: 500,
    stream: async function* () {
      calls++
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' }
      throw overflow()
    }
  })
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('context is full')
  expect(calls).toBe(1)
  expect(summaries).toHaveLength(0)
})

test('모델별 임계치와 여유 토큰 설정을 공통 설정보다 우선한다', async (t) => {
  const { ctx, summaries } = await setup(t, {
    tokens: 500,
    compaction: {
      threshold: 1,
      models: { test: { threshold: 0.5, reserveTokens: 100 } }
    }
  })
  await collect(ctx.agent.run(input))
  await setImmediate()
  expect(summaries).toHaveLength(1)
})

test('백그라운드 준비가 실패해도 정상 응답을 마친다', async (t) => {
  const { ctx } = await setup(t, {
    summary: async () => {
      throw new Error('summary unavailable')
    }
  })
  const events = await collect(ctx.agent.run(input))
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
})

test('플러그인 해제 시 응답 종료 후 진행 중인 준비도 취소한다', async (t) => {
  const started = Promise.withResolvers<AbortSignal>()
  const { ctx, agent } = await setup(t, {
    summary: async (signal) => {
      started.resolve(signal)
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    }
  })
  await collect(ctx.agent.run(input))
  const signal = await started.promise
  expect(signal.aborted).toBe(false)
  await agent.dispose()
  expect(signal.aborted).toBe(true)
})

test('잘못된 임계치와 모델별 보존 토큰 수를 설정 시 거부한다', () => {
  for (const compaction of [
    { threshold: 0 },
    { threshold: 1.1 },
    { threshold: NaN },
    { reserveTokens: -1 },
    { models: { test: { keepRecentTokens: -1 } } },
    { models: [] }
  ]) {
    expect(() => parseAgentConfig({ model: 'test', maxOutputTokens: 100, compaction })).toThrow()
  }
})

test('이전 실행의 준비를 기다리는 중에도 새 실행을 즉시 취소한다', async (t) => {
  const gate = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const { ctx, summaries } = await setup(t, {
    count: (request) => {
      if (request.input.messages.some((message) => message.id === 'large')) {
        waiting.resolve()
        return 950
      }
      return request.input.messages.some((message) => message.id === 'old') ? 800 : 100
    },
    summary: () => gate.promise
  })
  await collect(ctx.agent.run(input))
  const controller = new globalThis.AbortController()
  const pending = collect(
    ctx.agent.run(
      {
        ...input,
        runId: 'waiting',
        messages: [...input.messages, { id: 'large', role: 'user', content: 'large addition' }]
      },
      { signal: controller.signal }
    )
  )
  const assertion = expect(pending).rejects.toThrow('cancel waiting')
  await waiting.promise
  controller.abort(new Error('cancel waiting'))
  await assertion
  expect(summaries).toHaveLength(1)
  gate.resolve()
})

test('폐기된 준비가 늦게 끝나도 수정된 이력의 새 준비 결과를 덮어쓰지 않는다', async (t) => {
  const first = Promise.withResolvers<void>()
  let summaryCalls = 0
  const { ctx, requests, prepared } = await setup(t, {
    summary: async () => {
      if (++summaryCalls === 1) await first.promise
    }
  })
  await collect(ctx.agent.run(input))
  const changed: RunAgentInput = {
    ...input,
    runId: 'edited',
    messages: input.messages.map((message) =>
      message.id === 'old' && message.role === 'user' ? { ...message, content: 'corrected history' } : message
    )
  }
  await collect(ctx.agent.run(changed))
  await prepared()
  first.resolve()
  await setImmediate()
  await collect(ctx.agent.run({ ...changed, runId: 'use-new-summary' }))
  const last = requests.at(-1)!
  expect(last.input.messages.some((message) => message.id === 'old')).toBe(false)
  expect(summaryCalls).toBe(2)
})

test('도구 후속 요청의 초과 오류를 재시도해도 완료된 도구는 다시 실행하지 않는다', async (t) => {
  let calls = 0
  let executions = 0
  const { ctx, requests } = await setup(t, {
    tokens: 500,
    tools: [
      {
        name: 'lookup',
        description: 'look up',
        parameters: { type: 'object' },
        execute: () => {
          executions++
          return 'result'
        }
      }
    ],
    stream: async function* () {
      calls++
      if (calls === 1) {
        yield { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'lookup' }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '{}' }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'call' }
      } else if (calls === 2) throw overflow()
      else yield* text('final', 'done')
    }
  })
  const events = await collect(ctx.agent.run(input))
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(executions).toBe(1)
  expect(calls).toBe(3)
  expect(requests.at(-1)?.input.messages).toContainEqual(
    expect.objectContaining({ role: 'tool', toolCallId: 'call', content: 'result' })
  )
})

test.for([
  {
    condition: 'OpenAI 실패 이벤트',
    error: new Error('failed', { cause: { response: { error: { code: 'context_length_exceeded' } } } })
  },
  {
    condition: 'Anthropic 입력 초과',
    error: Object.assign(new Error('prompt is too long: 1200 > 1000'), { status: 400 })
  },
  {
    condition: 'Gemini 입력 초과',
    error: Object.assign(
      new Error('The input token count (1200) exceeds the maximum number of tokens allowed (1000).'),
      { status: 400 }
    )
  }
])('공급자가 명시한 입력 초과를 한 번 재시도한다: $condition', async ({ error }, t) => {
  let calls = 0
  const { ctx } = await setup(t, {
    tokens: 500,
    stream: async function* () {
      if (++calls === 1) throw error
      yield* text('final', 'done')
    }
  })
  expect((await collect(ctx.agent.run(input))).at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(calls).toBe(2)
})

test.for([
  { condition: '인증 오류', error: Object.assign(new Error('unauthorized'), { status: 401 }) },
  { condition: '요청 제한', error: Object.assign(new Error('input tokens exceed rate limit'), { status: 429 }) },
  { condition: '출력 예산 오류', error: Object.assign(new Error('output exceeds maximum tokens'), { status: 400 }) },
  { condition: '일반 오류', error: new Error('provider unavailable') }
])('컨텍스트 초과가 아닌 오류는 축약하거나 재시도하지 않는다: $condition', async ({ error }, t) => {
  let calls = 0
  const { ctx, summaries } = await setup(t, {
    tokens: 500,
    stream: () => {
      calls++
      throw error
    }
  })
  await expect(collect(ctx.agent.run(input))).rejects.toBe(error)
  expect(calls).toBe(1)
  expect(summaries).toHaveLength(0)
})

test('입력 예산을 넘으면 진행 중인 준비를 재사용하고 새 메시지도 보존한다', async (t) => {
  const gate = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const { ctx, summaries, requests } = await setup(t, {
    count: (request) => {
      if (!request.input.messages.some((message) => message.id === 'old')) return 100
      if (request.input.messages.some((message) => message.id === 'large')) {
        waiting.resolve()
        return 950
      }
      return 800
    },
    summary: () => gate.promise
  })
  await collect(ctx.agent.run(input))
  const pending = collect(
    ctx.agent.run({
      ...input,
      runId: 'wait-and-reuse',
      messages: [...input.messages, { id: 'large', role: 'user', content: 'new data' }]
    })
  )
  await waiting.promise
  expect(requests).toHaveLength(1)
  gate.resolve()
  expect((await pending).at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(summaries).toHaveLength(1)
  expect(requests.at(-1)?.input.messages.at(-1)?.id).toBe('large')
})

test('모델별 여유 토큰을 입력 예산에서 차감하여 동기 축약한다', async (t) => {
  const { ctx, requests } = await setup(t, {
    tokens: 500,
    compaction: {
      models: { test: { reserveTokens: 450 } }
    }
  })
  await collect(ctx.agent.run(input))
  expect(requests[0].input.messages.some((message) => message.id === 'old')).toBe(false)
  expect((await ctx.generation.get('run'))?.request.compaction?.sourceMessageIds).toStrictEqual(['old', 'answer'])
})

for (const mode of ['external', 'return']) {
  test(`${mode} 요청으로 현재 실행의 백그라운드 준비도 취소한다`, async (t) => {
    const started = Promise.withResolvers<AbortSignal>()
    const { ctx } = await setup(t, {
      summary: async (signal) => {
        started.resolve(signal)
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
      }
    })
    const external = new globalThis.AbortController()
    const iterator = ctx.agent.run(input, { signal: external.signal })
    await iterator.next()
    await iterator.next()
    const signal = await started.promise
    if (mode === 'external') external.abort(new Error('cancelled'))
    await iterator.return!()
    expect(signal.aborted).toBe(true)
  })
}

test('준비 이후 추가된 도구 결과의 호출이 요약되었다면 준비 결과를 폐기한다', async (t) => {
  const { ctx, requests, prepared } = await setup(t)
  const withCall: RunAgentInput = {
    ...input,
    messages: [
      input.messages[0],
      {
        id: 'answer',
        role: 'assistant',
        toolCalls: [{ id: 'late-call', type: 'function', function: { name: 'lookup', arguments: '{}' } }]
      },
      input.messages[2]
    ]
  }
  await collect(ctx.agent.run(withCall))
  await prepared()
  await collect(
    ctx.agent.run({
      ...withCall,
      runId: 'late-result',
      messages: [...withCall.messages, { id: 'late-result', role: 'tool', toolCallId: 'late-call', content: 'result' }]
    })
  )
  const messages = requests.at(-1)!.input.messages
  expect(messages).toContainEqual(withCall.messages[1])
  expect(messages).toContainEqual(expect.objectContaining({ role: 'tool', toolCallId: 'late-call' }))
})

test.for([
  { condition: '함수', state: { callback: () => {} } },
  { condition: 'BigInt', state: { count: 1n } },
  {
    condition: '순환 참조',
    state: (() => {
      const value: Record<string, unknown> = {}
      value.self = value
      return value
    })()
  }
])('준비에서 복제하거나 비교할 수 없는 상태도 정상 생성한다: $condition', async ({ state }, t) => {
  const { ctx, requests } = await setup(t)
  const request = { ...input, state }
  expect((await collect(ctx.agent.run(request))).at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect((await collect(ctx.agent.run({ ...request, runId: 'opaque-again' }))).at(-1)?.type).toBe(
    EventType.RUN_FINISHED
  )
  expect(requests).toHaveLength(2)
})
