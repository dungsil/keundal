import { getEventListeners } from 'node:events'

import {
  EventType,
  LLMService,
  type AGUIEvent,
  type ExecutionOptions,
  type GenerationRequest,
  type LLMEvent,
  type LLMModel,
  type LLMRequest
} from '@keundal/core'
import memoryStorePlugin, { MemoryStore } from '@keundal/plugin-store-memory'
import { Context, type Fiber } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const request = (runId = 'run', sessionRevision = 0): GenerationRequest => ({
  input: { threadId: 'thread', runId, state: { step: 1 }, messages: [], tools: [], context: [] },
  model: 'test',
  maxOutputTokens: 10,
  sessionRevision
})

const collect = async (stream: AsyncIterable<AGUIEvent>): Promise<AGUIEvent[]> => {
  const events: AGUIEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

async function setup(t: TestContext, store?: MemoryStore, hold = false) {
  const ctx = new Context()
  const held = Promise.withResolvers<void>()
  const calls: LLM[] = []
  let signal: AbortSignal | undefined
  let closed = false
  class LLM extends LLMService {
    async getModel(): Promise<LLMModel> {
      throw new Error('unused')
    }
    async countTokens(): Promise<number> {
      throw new Error('unused')
    }
    async *stream(request: LLMRequest, options: ExecutionOptions = {}): AsyncGenerator<LLMEvent> {
      signal = options.signal
      if (!signal) throw new Error('generation must forward a cancellation signal')
      calls.push(this)
      const messageId = `${request.input.runId}-reply`
      try {
        yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'hello' }
        if (hold) {
          const halted = Promise.withResolvers<void>()
          signal.addEventListener('abort', () => halted.reject(signal!.reason), { once: true })
          held.resolve()
          await halted.promise
        }
        yield { type: EventType.TEXT_MESSAGE_END, messageId }
      } finally {
        closed = true
      }
    }
  }
  const fibers: Fiber[] = []
  t.onTestFinished(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
  })
  const llmFiber = await ctx.plugin(LLM)
  const storeFiber = await ctx.plugin(memoryStorePlugin, store ? { store } : {})
  fibers.push(llmFiber, storeFiber)
  return {
    ctx,
    llmFiber,
    storeFiber,
    held: held.promise,
    calls,
    getSignal: () => signal,
    isClosed: () => closed,
    replaceLLM: async () => fibers.push(await ctx.plugin(LLM)),
    registerStore: async () => fibers.push(await ctx.plugin(memoryStorePlugin))
  }
}

for (const configured of [false, true]) {
  test(`${configured ? '명시한' : '기본'} 저장소는 LLM 교체 뒤에도 세션과 완료된 journal을 유지한다`, async (t) => {
    const store = configured ? new MemoryStore() : undefined
    const { ctx, llmFiber, replaceLLM, calls } = await setup(t, store)
    const events = await collect(ctx.generation.run(request()))
    const session = await ctx.session.get('thread')
    const run = await ctx.generation.get('run')
    const previousSession = ctx.session
    const previousGeneration = ctx.generation

    await llmFiber.dispose()
    expect(ctx.generation).toBeUndefined()
    expect(await ctx.session.get('thread')).toEqual(session)
    expect(await previousSession.get('thread')).toEqual(session)
    await expect(previousGeneration.get('run')).rejects.toThrow(/disposed/)
    await replaceLLM()

    expect(await previousSession.get('thread')).toEqual(session)
    expect(await ctx.session.get('thread')).toEqual(session)
    expect((await ctx.session.prepare(request('next').input)).revision).toBe(1)
    expect(await ctx.generation.get('run')).toEqual(run)
    expect((await ctx.generation.recover())[0]).toEqual(run)
    expect(run?.status).toBe('completed')
    expect(run?.journal.map((entry) => entry.event)).toEqual(events)
    await collect(ctx.generation.run(request('next', 1)))
    expect((await ctx.session.get('thread'))?.revision).toBe(2)
    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toBe(calls[1])
  })
}

test('LLM 교체는 대기 중인 생성을 취소하고 기본 저장소의 부분 journal을 복구한다', async (t) => {
  const { ctx, llmFiber, replaceLLM, held, calls, getSignal, isClosed } = await setup(t, undefined, true)
  const external = new globalThis.AbortController()
  const iterator = ctx.generation.run(request(), { signal: external.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()
  await iterator.next()
  const partial = await ctx.generation.get('run')
  const pending = iterator.next()
  const rejected = expect(pending).rejects.toThrow(/disposed/)
  await held

  await llmFiber.dispose()
  await rejected
  expect(getSignal()?.aborted).toBe(true)
  expect(isClosed()).toBe(true)
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
  await replaceLLM()

  const recovered = await ctx.generation.recover()
  expect(recovered).toEqual([{ ...partial, status: 'interrupted' }])
  expect(recovered[0]?.messages).toEqual([{ id: 'run-reply', role: 'assistant', content: 'hello' }])
  expect((await ctx.session.get('thread'))?.revision).toBe(0)
  expect(calls).toHaveLength(1)
})

test('서로 다른 기본 저장소 등록은 세션과 실행 기록을 공유하지 않는다', async (t) => {
  const first = await setup(t)
  await collect(first.ctx.generation.run(request()))
  const second = await setup(t)
  expect(await second.ctx.session.get('thread')).toBeUndefined()
  expect(await second.ctx.generation.get('run')).toBeUndefined()

  await first.storeFiber.dispose()
  await first.registerStore()
  expect(await first.ctx.session.get('thread')).toBeUndefined()
  expect(await first.ctx.generation.get('run')).toBeUndefined()
})
