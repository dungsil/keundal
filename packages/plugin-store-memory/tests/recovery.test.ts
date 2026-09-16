import { getEventListeners } from 'node:events'

import {
  EventType,
  LLMService,
  type ExecutionOptions,
  type LLMEvent,
  type LLMModel,
  type LLMRequest,
  type GenerationRequest,
  type AGUIEvent
} from '@keundal/core'
import memoryStorePlugin, { MemoryStore } from '@keundal/plugin-store-memory'
import { Context, type Fiber } from 'cordis'
import { expect, test } from 'vitest'

const req = (runId = 'run', revision = 0): GenerationRequest => ({
  input: { threadId: 'thread', runId, messages: [], tools: [], context: [] },
  model: 'test',
  maxOutputTokens: 10,
  sessionRevision: revision
})
const reply: LLMEvent[] = [
  { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'hello' }
]
async function* stream(events: LLMEvent[], signal: AbortSignal, hold?: () => Promise<void>, failure?: Error) {
  let count = 0
  for (const event of events) {
    signal.throwIfAborted()
    yield event
    count += 1
    if (hold && count === 2) await hold()
  }
  if (failure) throw failure
}
async function setup(store = new MemoryStore(), holdEnabled = true, failure?: Error) {
  const ctx = new Context()
  const fibers: Fiber[] = []
  let wait!: () => void
  const held = new Promise<void>((resolve) => {
    wait = resolve
  })
  class LLM extends LLMService {
    calls = 0
    async getModel(): Promise<LLMModel> {
      throw new Error('unused')
    }
    async countTokens(): Promise<number> {
      throw new Error('unused')
    }
    stream(_request: LLMRequest, options: ExecutionOptions = {}) {
      this.calls++
      return stream(
        reply,
        options.signal!,
        holdEnabled
          ? async () => {
              wait()
              await new Promise((_, reject) =>
                options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
              )
            }
          : undefined,
        failure
      )
    }
  }
  fibers.push(await ctx.plugin(LLM), await ctx.plugin(memoryStorePlugin, { store }))
  return { ctx, store, fibers, llm: ctx.llm as LLM, held }
}
test('abort 이후 next 없이도 get으로 cancelled 상태를 확인한다', async (t) => {
  const { ctx, fibers } = await setup()
  const c = new globalThis.AbortController()
  const it = ctx.generation.run(req(), { signal: c.signal }) as AsyncIterableIterator<AGUIEvent>
  await it.next()
  c.abort(new Error('cancelled'))
  expect((await ctx.generation.get('run'))?.status).toBe('cancelled')
  t.onTestFinished(async () => {
    for (const f of fibers.toReversed()) await f.dispose()
  })
})
test('pending next 중 return은 스트림을 중단하고 interrupted로 확정한다', async (t) => {
  const { ctx, fibers, held } = await setup()
  const it = ctx.generation.run(req()) as AsyncIterableIterator<AGUIEvent>
  await it.next()
  await it.next()
  await it.next()
  const pending = it.next()
  await held
  const returned = it.return?.(undefined)
  await expect(pending).rejects.toThrow('stopped')
  await returned
  expect((await ctx.generation.get('run'))?.status).toBe('interrupted')
  t.onTestFinished(async () => {
    for (const f of fibers.toReversed()) await f.dispose()
  })
})
test('동일 store 재등록 recover가 부분 응답을 interrupted로 확정하고 재호출하지 않는다', async (t) => {
  const store = new MemoryStore()
  const first = await setup(store)
  const it = first.ctx.generation.run(req()) as AsyncIterableIterator<AGUIEvent>
  await it.next()
  await it.next()
  await it.next()
  await first.fibers[1]!.dispose()
  await first.fibers[0]!.dispose()
  const second = await setup(store)
  const recovered = await second.ctx.generation.recover()
  expect(recovered[0]?.status).toBe('interrupted')
  expect(recovered[0]?.messages).toEqual([{ id: 'reply', role: 'assistant', content: 'hello' }])
  expect(second.llm.calls).toBe(0)
  expect((await second.ctx.generation.recover())[0]?.status).toBe('interrupted')
  t.onTestFinished(async () => {
    for (const f of second.fibers.toReversed()) await f.dispose()
  })
})
test('중복 runId는 기존 실행 상태를 변경하지 않는다', async (t) => {
  const { ctx, fibers } = await setup()
  const first = ctx.generation.run(req()) as AsyncIterableIterator<AGUIEvent>
  await first.next()
  const duplicate = ctx.generation.run(req()) as AsyncIterableIterator<AGUIEvent>
  await expect(duplicate.next()).rejects.toThrow('already recorded')
  expect((await ctx.generation.get('run'))?.status).toBe('running')
  expect((await ctx.generation.recover())[0]?.status).toBe('running')
  t.onTestFinished(async () => {
    for (const f of fibers.toReversed()) await f.dispose()
  })
})
test('completed 실행은 재등록 recover 반복 뒤에도 completed를 유지한다', async (t) => {
  const store = new MemoryStore()
  const first = await setup(store, false)
  for await (const _event of first.ctx.generation.run(req())) void _event
  await first.fibers[1]!.dispose()
  await first.fibers[0]!.dispose()
  const second = await setup(store, false)
  expect((await second.ctx.generation.recover())[0]?.status).toBe('completed')
  expect((await second.ctx.generation.recover())[0]?.status).toBe('completed')
  t.onTestFinished(async () => {
    for (const f of second.fibers.toReversed()) await f.dispose()
  })
})
test('failed 실행은 재등록 recover 뒤에도 failed를 유지한다', async (t) => {
  const store = new MemoryStore()
  const first = await setup(store, false, new Error('failed'))
  await expect(
    (async () => {
      for await (const _event of first.ctx.generation.run(req())) void _event
    })()
  ).rejects.toThrow('failed')
  await first.fibers[1]!.dispose()
  await first.fibers[0]!.dispose()
  const second = await setup(store, false)
  expect((await second.ctx.generation.recover())[0]?.status).toBe('failed')
  expect((await second.ctx.generation.recover())[0]?.status).toBe('failed')
  t.onTestFinished(async () => {
    for (const f of second.fibers.toReversed()) await f.dispose()
  })
})
test('cancelled 실행은 재등록 recover 뒤에도 cancelled를 유지한다', async (t) => {
  const store = new MemoryStore()
  const first = await setup(store)
  const c = new globalThis.AbortController()
  const it = first.ctx.generation.run(req(), { signal: c.signal }) as AsyncIterableIterator<AGUIEvent>
  await it.next()
  c.abort(new Error('cancelled'))
  await first.fibers[1]!.dispose()
  await first.fibers[0]!.dispose()
  const second = await setup(store, false)
  expect((await second.ctx.generation.recover())[0]?.status).toBe('cancelled')
  expect((await second.ctx.generation.recover())[0]?.status).toBe('cancelled')
  t.onTestFinished(async () => {
    for (const f of second.fibers.toReversed()) await f.dispose()
  })
})
test('살아 있는 다른 서비스의 실행은 recover에서 running을 유지한다', async (t) => {
  const store = new MemoryStore()
  const first = await setup(store)
  const it = first.ctx.generation.run(req()) as AsyncIterableIterator<AGUIEvent>
  await it.next()
  const second = await setup(store, false)
  expect((await second.ctx.generation.recover())[0]?.status).toBe('running')
  await it.return?.(undefined)
  t.onTestFinished(async () => {
    for (const f of [...second.fibers, ...first.fibers].toReversed()) await f.dispose()
  })
})
test('시작하지 않은 duplicate iterator abort는 원본 실행을 변경하지 않는다', async (t) => {
  const { ctx, fibers, llm } = await setup()
  const first = ctx.generation.run(req()) as AsyncIterableIterator<AGUIEvent>
  await first.next()
  await first.next()
  const c = new globalThis.AbortController()
  const duplicate = ctx.generation.run(req(), { signal: c.signal }) as AsyncIterableIterator<AGUIEvent>
  c.abort(new Error('duplicate cancelled'))
  await expect(duplicate.next()).rejects.toThrow('duplicate cancelled')
  expect((await ctx.generation.get('run'))?.status).toBe('running')
  await first.return?.(undefined)
  expect(llm.calls).toBe(1)
  t.onTestFinished(async () => {
    for (const f of fibers.toReversed()) await f.dispose()
  })
})
test('return 실패 뒤 외부 signal listener를 정리한다', async (t) => {
  const { ctx, fibers } = await setup(new MemoryStore(), false)
  const c = new globalThis.AbortController()
  const it = ctx.generation.run(req(), { signal: c.signal }) as AsyncIterableIterator<AGUIEvent>
  await it.next()
  await ctx.session.commit({ threadId: 'thread', expectedRevision: 0, messages: [], state: undefined })
  await expect(it.return?.(undefined)).rejects.toThrow(/revision conflict/)
  expect(getEventListeners(c.signal, 'abort')).toHaveLength(0)
  t.onTestFinished(async () => {
    for (const f of fibers.toReversed()) await f.dispose()
  })
})
test('커밋 실패는 성공 종료 journal을 노출하지 않고 recover 가능한 interrupted로 남긴다', async (t) => {
  const { ctx, fibers } = await setup(new MemoryStore(), false)
  const it = ctx.generation.run(req()) as AsyncIterableIterator<AGUIEvent>
  await ctx.session.commit({ threadId: 'thread', expectedRevision: 0, messages: [], state: undefined })
  await expect(
    (async () => {
      for await (const event of it) void event
    })()
  ).rejects.toThrow(/revision conflict/)
  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('interrupted')
  expect(run?.journal.some((entry) => entry.event.type === EventType.RUN_FINISHED)).toBe(false)
  expect((await ctx.generation.recover())[0]?.status).toBe('interrupted')
  t.onTestFinished(async () => {
    for (const f of fibers.toReversed()) await f.dispose()
  })
})
