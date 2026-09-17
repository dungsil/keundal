import {
  EventType,
  LLMService,
  type AGUIEvent,
  type ExecutionOptions,
  type GenerationRequest,
  type LLMEvent,
  type LLMModel,
  type LLMRequest,
  type RunAgentInput
} from '@keundal/core'
import memoryStorePlugin, { MemoryStore } from '@keundal/plugin-store-memory'
import { Context, type Fiber } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

interface Script {
  readonly events: LLMEvent[]
  /** 스트림이 모든 이벤트를 낸 뒤 실패시킬 오류입니다. */
  readonly fail?: Error
  /** 이 개수만큼 이벤트를 낸 뒤 취소될 때까지 기다립니다. */
  readonly holdAfter?: number
}

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: { step: 1 },
  messages: [{ id: 'question', role: 'user', content: 'question' }],
  tools: [],
  context: []
}

const reply: LLMEvent[] = [
  { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'hello' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
]

const collect = async (stream: AsyncIterable<AGUIEvent>): Promise<AGUIEvent[]> => {
  const collected: AGUIEvent[] = []
  for await (const event of stream) collected.push(event)
  return collected
}

const types = (events: readonly AGUIEvent[]): string[] => events.map((event) => event.type)

async function* deliver(script: Script, signal: AbortSignal, reached: () => void): AsyncGenerator<LLMEvent> {
  let delivered = 0
  for (const event of script.events) {
    signal.throwIfAborted()
    yield event
    delivered++
    if (script.holdAfter !== undefined && delivered === script.holdAfter) {
      reached()
      const halted = Promise.withResolvers<void>()
      signal.addEventListener('abort', () => halted.reject(signal.reason), { once: true })
      await halted.promise
    }
    if (script.fail && delivered === script.events.length) throw script.fail
  }
}

async function setup(testContext: TestContext, script: Script, store = new MemoryStore()) {
  const ctx = new Context()
  const calls: string[] = []
  const held = Promise.withResolvers<void>()
  class LLM extends LLMService {
    async getModel(): Promise<LLMModel> {
      throw new Error('generation must not resolve model limits')
    }
    async countTokens(): Promise<number> {
      throw new Error('generation must not count tokens')
    }
    stream(request: LLMRequest, options: ExecutionOptions = {}): AsyncIterableIterator<LLMEvent> {
      const signal = options.signal
      if (!signal) throw new Error('generation must forward a cancellation signal')
      calls.push('stream')
      return deliver(script, signal, held.resolve)
    }
  }
  const fibers: Fiber[] = []
  testContext.onTestFinished(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
  })
  fibers.push(await ctx.plugin(LLM), await ctx.plugin(memoryStorePlugin, { store }))
  return { ctx, store, calls, held: held.promise, fibers }
}

const request = (runId: string, sessionRevision = 0): GenerationRequest => ({
  input: { ...input, runId },
  model: 'test-model',
  maxOutputTokens: 20,
  sessionRevision
})

test('성공한 실행은 커밋 이후에 RUN_FINISHED를 전달하고 실행을 completed로 확정한다', async (t) => {
  const { ctx } = await setup(t, { events: reply })
  const delivered: AGUIEvent[] = []
  let committed: string[] | undefined
  for await (const event of ctx.generation.run(request('run'))) {
    if (event.type === EventType.RUN_FINISHED) {
      committed = (await ctx.session.get('thread'))?.messages.map((message) => message.id)
    }
    delivered.push(event)
  }

  expect(committed, 'RUN_FINISHED must be delivered after the session commit').toEqual(['reply'])
  expect(types(delivered)).toEqual([
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED
  ])
  expect(await ctx.session.get('thread')).toEqual({
    threadId: 'thread',
    revision: 1,
    messages: [{ id: 'reply', role: 'assistant', content: 'hello' }],
    state: { step: 1 }
  })
  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('completed')
  expect(types(run?.journal.map((entry) => entry.event) ?? [])).toEqual(types(delivered))
  expect(run?.journal.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3, 4])
  expect(run?.messages).toEqual([{ id: 'reply', role: 'assistant', content: 'hello' }])
})

test('도구 호출과 추론 요약을 실행 결과 메시지로 조립한다', async (t) => {
  const { ctx } = await setup(t, {
    events: [
      { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'search' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '{"query":' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '"keundal"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'call' },
      { type: EventType.REASONING_MESSAGE_START, messageId: 'thinking', role: 'reasoning' },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'thinking', delta: 'search first' },
      { type: EventType.REASONING_MESSAGE_END, messageId: 'thinking' },
      { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId: 'thinking', encryptedValue: 'sealed' }
    ]
  })
  await collect(ctx.generation.run(request('run')))

  expect((await ctx.session.get('thread'))?.messages).toEqual([
    {
      id: 'call',
      role: 'assistant',
      toolCalls: [{ id: 'call', type: 'function', function: { name: 'search', arguments: '{"query":"keundal"}' } }]
    },
    { id: 'thinking', role: 'reasoning', content: 'search first', encryptedValue: 'sealed' }
  ])
})

test('prepare는 저장된 대화와 요청 메시지를 병합하고 저장된 원본을 변경하지 않는다', async (t) => {
  const { ctx } = await setup(t, { events: reply })
  await collect(ctx.generation.run(request('run')))
  const stored = await ctx.session.get('thread')

  const prepared = await ctx.session.prepare({
    ...input,
    runId: 'next',
    messages: [
      { id: 'question', role: 'user', content: 'question' },
      { id: 'follow-up', role: 'user', content: 'follow up' }
    ]
  })

  expect(prepared.revision).toBe(1)
  expect(prepared.input.threadId).toBe('thread')
  expect(prepared.input.runId).toBe('next')
  expect(prepared.input.messages.map((message) => message.id)).toEqual(['reply', 'question', 'follow-up'])
  expect(await ctx.session.get('thread')).toEqual(stored)
})

test('commit은 기준 revision이 다르면 거부하고 저장된 상태를 유지한다', async (t) => {
  const { ctx } = await setup(t, { events: [] })
  const answered = await ctx.session.commit({
    threadId: 'thread',
    expectedRevision: 0,
    messages: [{ id: 'a', role: 'user', content: 'a' }],
    state: { step: 1 }
  })
  expect(answered.revision).toBe(1)

  await expect(
    ctx.session.commit({
      threadId: 'thread',
      expectedRevision: 0,
      messages: [{ id: 'b', role: 'user', content: 'b' }],
      state: { step: 2 }
    })
  ).rejects.toThrow(/revision conflict/)

  expect(await ctx.session.get('thread')).toEqual(answered)
})

test('같은 실행의 종료 기록을 두 번 커밋해도 메시지와 revision을 중복 반영하지 않는다', async (t) => {
  const { ctx } = await setup(t, { events: reply })
  await collect(ctx.generation.run(request('run')))
  const stored = await ctx.session.get('thread')
  const run = await ctx.generation.get('run')
  if (!stored || !run) throw new Error('the first run must be recorded')

  const repeated = await ctx.session.commit({
    threadId: 'thread',
    expectedRevision: stored.revision,
    messages: run.messages,
    state: stored.state,
    generation: { request: run.request, status: 'completed', journal: run.journal, messages: run.messages }
  })

  expect(repeated).toEqual(stored)
})

test('같은 종료 commit을 다시 적용해도 revision과 메시지를 중복 반영하지 않는다', async (t) => {
  const { ctx } = await setup(t, { events: reply })
  await collect(ctx.generation.run(request('run')))
  const stored = await ctx.session.get('thread')
  const run = await ctx.generation.get('run')
  if (!stored || !run) throw new Error('the first run must be recorded')

  await expect(
    ctx.session.commit({
      threadId: 'thread',
      expectedRevision: 0,
      messages: run.messages,
      state: stored.state,
      generation: { request: run.request, status: 'completed', journal: run.journal, messages: run.messages }
    })
  ).resolves.toEqual(stored)
  expect(await ctx.session.get('thread')).toEqual(stored)
})

test('LLM 스트림 실패는 실행을 failed로 확정하고 부분 응답만 남긴다', async (t) => {
  const { ctx } = await setup(t, {
    events: reply.slice(0, 2),
    fail: new Error('openai stream failed')
  })

  await expect(collect(ctx.generation.run(request('run')))).rejects.toThrow('openai stream failed')

  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('failed')
  expect(types(run?.journal.map((entry) => entry.event) ?? [])).toEqual([
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT
  ])
  expect(run?.messages).toEqual([{ id: 'reply', role: 'assistant', content: 'hello' }])
  // 실패한 실행은 대화와 상태를 반영하지 않고 종료 기록만 확정한다.
  expect(await ctx.session.get('thread')).toEqual({
    threadId: 'thread',
    revision: 1,
    messages: [],
    state: undefined
  })
})

test('외부 취소는 실행을 cancelled로 확정하고 부분 journal을 보존한다', async (t) => {
  const { ctx, held } = await setup(t, { events: reply, holdAfter: 1 })
  const controller = new globalThis.AbortController()
  const running = collect(ctx.generation.run(request('run'), { signal: controller.signal }))
  await held

  controller.abort(new Error('cancelled by client'))
  await expect(running).rejects.toThrow('cancelled by client')

  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('cancelled')
  expect(types(run?.journal.map((entry) => entry.event) ?? [])).toEqual([
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START
  ])
  expect((await ctx.session.get('thread'))?.messages).toEqual([])
})

test('소비자가 순회를 중단한 실행은 interrupted로 확정한다', async (t) => {
  const { ctx } = await setup(t, { events: reply })
  const iterator = ctx.generation.run(request('run'))[Symbol.asyncIterator]()
  expect((await iterator.next()).value?.type).toBe(EventType.RUN_STARTED)
  await iterator.return?.(undefined)

  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('interrupted')
  expect(types(run?.journal.map((entry) => entry.event) ?? [])).toEqual([EventType.RUN_STARTED])
})

test('LLM 응답을 기다리던 실행은 저장소 재등록 뒤 복구하면 interrupted로 확정하고 LLM을 재호출하지 않는다', async (t) => {
  const store = new MemoryStore()
  const { ctx, calls, held, fibers } = await setup(t, { events: reply, holdAfter: 2 }, store)
  const controller = new globalThis.AbortController()
  const running = collect(ctx.generation.run(request('run'), { signal: controller.signal }))
  await held

  // 서비스가 해제되면 실행 중이던 기록은 종료를 확정하지 않고 남는다.
  await fibers[1]?.dispose()
  await running.catch(() => {})

  fibers.push(await ctx.plugin(memoryStorePlugin, { store }))
  const recovered = await ctx.generation.recover()

  expect(recovered.map((snapshot) => snapshot.status)).toEqual(['interrupted'])
  expect(recovered[0]?.messages).toEqual([{ id: 'reply', role: 'assistant', content: 'hello' }])
  expect(calls.filter((call) => call === 'stream')).toEqual(['stream'])
})
