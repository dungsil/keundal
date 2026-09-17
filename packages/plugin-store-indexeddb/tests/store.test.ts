import {
  EventType,
  LLMService,
  type ExecutionOptions,
  type GenerationRequest,
  type LLMEvent,
  type LLMModel,
  type LLMRequest
} from '@keundal/core'
import indexedDBStorePlugin, { IndexedDBStore, type WebLockManager } from '@keundal/plugin-store-indexeddb'
import { Context, type Fiber } from 'cordis'
import { IDBFactory } from 'fake-indexeddb'
import { expect, test, type TestContext } from 'vitest'

class Locks implements WebLockManager {
  private readonly states = new Map<string, { locked: boolean; waiters: (() => void)[] }>()

  async request<T>(
    name: string,
    options: { readonly ifAvailable?: boolean; readonly signal?: AbortSignal },
    callback: (lock: unknown | null) => T | Promise<T>
  ): Promise<T> {
    options.signal?.throwIfAborted()
    const state = this.states.get(name) ?? { locked: false, waiters: [] }
    this.states.set(name, state)
    if (options.ifAvailable && state.locked) return callback(null)
    if (state.locked) await new Promise<void>((resolve) => state.waiters.push(resolve))
    options.signal?.throwIfAborted()
    state.locked = true
    try {
      return await callback({})
    } finally {
      state.locked = false
      state.waiters.shift()?.()
    }
  }
}

const request = (runId = 'run', revision = 0): GenerationRequest => ({
  input: {
    threadId: 'thread',
    runId,
    state: { step: 1 },
    messages: [{ id: 'question', role: 'user', content: 'question' }],
    tools: [],
    context: []
  },
  model: 'test',
  maxOutputTokens: 10,
  sessionRevision: revision
})

async function setup(
  testContext: TestContext,
  events: LLMEvent[] = [],
  store = new IndexedDBStore({
    databaseName: `test-${globalThis.crypto.randomUUID()}`,
    indexedDB: new IDBFactory(),
    locks: new Locks()
  }),
  afterEvents?: Promise<void>
) {
  const ctx = new Context()
  const fibers: Fiber[] = []
  let calls = 0
  class LLM extends LLMService {
    async getModel(): Promise<LLMModel> {
      throw new Error('unused')
    }
    async countTokens(): Promise<number> {
      throw new Error('unused')
    }
    async *stream(_request: LLMRequest, options: ExecutionOptions = {}) {
      calls++
      for (const event of events) {
        options.signal?.throwIfAborted()
        yield event
      }
      await afterEvents
    }
  }
  fibers.push(await ctx.plugin(LLM), await ctx.plugin(indexedDBStorePlugin, { store }))
  testContext.onTestFinished(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    store.close()
  })
  return { ctx, fibers, store, calls: () => calls }
}

async function eventually<T>(value: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const found = await value()
    if (found !== undefined) return found
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2))
  }
  throw new Error('condition was not reached')
}

test('이벤트를 전달하기 전에 journal에 저장하고 완료 커밋 뒤 RUN_FINISHED를 전달한다', async (t) => {
  const { ctx } = await setup(t, [
    { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'hello' }
  ])
  const delivered = []
  for await (const event of ctx.generation.run(request())) {
    if (event.type !== EventType.RUN_FINISHED) {
      const run = await ctx.generation.get('run')
      expect(run?.journal.map((entry) => entry.event.type)).toContain(event.type)
    } else {
      expect((await ctx.session.get('thread'))?.messages).toEqual([
        { id: 'reply', role: 'assistant', content: 'hello' }
      ])
    }
    delivered.push(event.type)
  }
  expect(delivered).toEqual([
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.RUN_FINISHED
  ])
  expect((await ctx.generation.get('run'))?.status).toBe('completed')
})

test('RUN_STARTED 뒤 취소하면 다음 next 없이 cancelled를 확정하고 LLM을 호출하지 않는다', async (t) => {
  const { ctx, calls } = await setup(t)
  const controller = new globalThis.AbortController()
  const iterator = ctx.generation.run(request(), { signal: controller.signal })[Symbol.asyncIterator]()
  expect((await iterator.next()).value?.type).toBe(EventType.RUN_STARTED)
  controller.abort(new Error('cancelled'))
  const run = await eventually(async () => {
    const current = await ctx.generation.get('run')
    return current?.status === 'cancelled' ? current : undefined
  })
  expect(run.journal).toHaveLength(1)
  expect(calls()).toBe(0)
})

test('부분 응답을 전달한 뒤 멈춘 반복자도 취소하면 cancelled로 확정한다', async (t) => {
  const never = new Promise<void>(() => {})
  const { ctx, calls } = await setup(
    t,
    [{ type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }],
    undefined,
    never
  )
  const controller = new globalThis.AbortController()
  const iterator = ctx.generation.run(request(), { signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  expect((await iterator.next()).value?.type).toBe(EventType.TEXT_MESSAGE_START)
  controller.abort(new Error('cancelled after content'))
  const run = await eventually(async () => {
    const current = await ctx.generation.get('run')
    return current?.status === 'cancelled' ? current : undefined
  })
  expect(calls()).toBe(1)
  expect(run.messages).toEqual([{ id: 'reply', role: 'assistant', content: '' }])
})

test('완료를 기다리는 동안 취소하면 cancelled만 확정하고 RUN_FINISHED를 전달하지 않는다', async (t) => {
  const gate = Promise.withResolvers<void>()
  const { ctx } = await setup(
    t,
    [{ type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }],
    undefined,
    gate.promise
  )
  const controller = new globalThis.AbortController()
  const iterator = ctx.generation.run(request(), { signal: controller.signal })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.next()
  const ending = iterator.next()
  controller.abort(new Error('cancelled before completion'))
  gate.resolve()
  await expect(ending).rejects.toThrow('cancelled before completion')
  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('cancelled')
  expect(run?.journal.some((entry) => entry.event.type === EventType.RUN_FINISHED)).toBe(false)
})

test('다른 탭이 실행 잠금을 보유하면 복구 시 running 상태를 유지한다', async (t) => {
  const factory = new IDBFactory()
  const locks = new Locks()
  const name = `shared-${globalThis.crypto.randomUUID()}`
  const firstStore = new IndexedDBStore({ databaseName: name, indexedDB: factory, locks })
  const first = await setup(t, [], firstStore)
  const iterator = first.ctx.generation.run(request())[Symbol.asyncIterator]()
  await iterator.next()

  const secondStore = new IndexedDBStore({ databaseName: name, indexedDB: factory, locks })
  const second = await setup(t, [], secondStore)
  expect((await second.ctx.generation.recover())[0]?.status).toBe('running')
  await iterator.return?.()
  expect((await second.ctx.generation.recover())[0]?.status).toBe('interrupted')
})

test('revision 충돌은 RUN_FINISHED를 저장하지 않고 실행을 recover 가능한 interrupted로 남긴다', async (t) => {
  const { ctx } = await setup(t)
  const iterator = ctx.generation.run(request())[Symbol.asyncIterator]()
  await iterator.next()
  await ctx.session.commit({ threadId: 'thread', expectedRevision: 0, messages: [], state: undefined })
  await expect(iterator.next()).rejects.toThrow(/revision conflict/)
  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('interrupted')
  expect(run?.journal.some((entry) => entry.event.type === EventType.RUN_FINISHED)).toBe(false)
})

test('잘못된 스트림 이벤트는 저장 전에 거부하고 마지막 유효 journal만 보존한다', async (t) => {
  const { ctx } = await setup(t, [{ type: EventType.TOOL_CALL_ARGS, toolCallId: 'missing', delta: '{}' }])
  const iterator = ctx.generation.run(request())[Symbol.asyncIterator]()
  await iterator.next()
  await expect(iterator.next()).rejects.toThrow(/no matching tool call/)
  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('failed')
  expect(run?.journal.map((entry) => entry.event.type)).toEqual([EventType.RUN_STARTED])
})

test('구조화 복제할 수 없는 session 변경은 transaction 전체를 되돌린다', async (t) => {
  const { ctx } = await setup(t)
  await expect(
    ctx.session.commit({
      threadId: 'clone-error',
      expectedRevision: 0,
      messages: [],
      state: { callback: () => {} }
    })
  ).rejects.toThrow()
  expect(await ctx.session.get('clone-error')).toBeUndefined()
})

test('generation 종료 transaction의 구조화 복제 오류는 run과 journal 변경도 함께 되돌린다', async (t) => {
  const { ctx, store } = await setup(t)
  const generation = request('clone-run')
  await store.startRun(generation)
  await store.appendEvent('clone-run', { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'clone-run' })
  await expect(
    ctx.session.commit({
      threadId: 'thread',
      expectedRevision: 0,
      messages: [],
      state: { callback: () => {} },
      generation: {
        request: generation,
        status: 'completed',
        messages: [],
        journal: [
          { sequence: 0, event: { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'clone-run' } },
          {
            sequence: 1,
            event: {
              type: EventType.RUN_FINISHED,
              threadId: 'thread',
              runId: 'clone-run',
              outcome: { type: 'success' }
            }
          }
        ]
      }
    })
  ).rejects.toThrow()
  const run = await ctx.generation.get('clone-run')
  expect(run?.status).toBe('running')
  expect(run?.journal.map((entry) => entry.event.type)).toEqual([EventType.RUN_STARTED])
})

test('같은 종료 commit을 다시 적용해도 revision과 메시지를 중복 반영하지 않는다', async (t) => {
  const { ctx } = await setup(t)
  for await (const _event of ctx.generation.run(request('idempotent'))) void _event
  const stored = await ctx.session.get('thread')
  const run = await ctx.generation.get('idempotent')
  if (!stored || !run) throw new Error('completed run must be stored')
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

test('동일 revision의 동시 session commit은 하나만 확정한다', async (t) => {
  const { ctx } = await setup(t)
  const results = await Promise.allSettled([
    ctx.session.commit({
      threadId: 'concurrent',
      expectedRevision: 0,
      messages: [{ id: 'first', role: 'user', content: 'first' }],
      state: { writer: 'first' }
    }),
    ctx.session.commit({
      threadId: 'concurrent',
      expectedRevision: 0,
      messages: [{ id: 'second', role: 'user', content: 'second' }],
      state: { writer: 'second' }
    })
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  expect((await ctx.session.get('concurrent'))?.revision).toBe(1)
})

test('데이터베이스를 다시 열어도 확정된 session을 복원한다', async (t) => {
  const factory = new IDBFactory()
  const locks = new Locks()
  const name = `reopen-${globalThis.crypto.randomUUID()}`
  const firstStore = new IndexedDBStore({ databaseName: name, indexedDB: factory, locks })
  const first = await setup(t, [], firstStore)
  await first.ctx.session.commit({
    threadId: 'persisted',
    expectedRevision: 0,
    messages: [{ id: 'message', role: 'user', content: 'persisted' }],
    state: { persisted: true }
  })
  for (const fiber of first.fibers.toReversed()) await fiber.dispose()
  firstStore.close()

  const secondStore = new IndexedDBStore({ databaseName: name, indexedDB: factory, locks })
  const second = await setup(t, [], secondStore)
  expect(await second.ctx.session.get('persisted')).toEqual({
    threadId: 'persisted',
    revision: 1,
    messages: [{ id: 'message', role: 'user', content: 'persisted' }],
    state: { persisted: true }
  })
})

test('중복 runId 시도는 기존 실행을 변경하지 않는다', async (t) => {
  const { ctx } = await setup(t)
  const first = ctx.generation.run(request())[Symbol.asyncIterator]()
  await first.next()
  const duplicate = ctx.generation.run(request())[Symbol.asyncIterator]()
  const pending = duplicate.next()
  const rejected = expect(pending).rejects.toThrow(/already (active|recorded)/)
  await first.return?.()
  await rejected
  expect((await ctx.generation.get('run'))?.status).toBe('interrupted')
})
