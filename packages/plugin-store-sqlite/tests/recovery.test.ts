import { getEventListeners } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
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
  messages: [],
  tools: [],
  context: []
}

const reply: LLMEvent[] = [
  { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'hello' }
]

const collect = async (stream: AsyncIterable<AGUIEvent>): Promise<AGUIEvent[]> => {
  const collected: AGUIEvent[] = []
  for await (const event of stream) collected.push(event)
  return collected
}

const statuses = (runs: readonly { status: string }[]): string[] => runs.map((run) => run.status)

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

/** 테스트마다 임시 디렉터리를 만들고, 연결이 닫힌 뒤에 지웁니다. */
function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-sqlite-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5 }))
  return join(directory, 'keundal.sqlite')
}

async function setup(t: TestContext, script: Script, path: string) {
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
  t.onTestFinished(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
  })
  fibers.push(await ctx.plugin(LLM), await ctx.plugin(sqliteStorePlugin, { path }))
  return { ctx, calls, held: held.promise, fibers }
}

const request = (runId = 'run'): GenerationRequest => ({
  input: { ...input, runId },
  model: 'test-model',
  maxOutputTokens: 10,
  sessionRevision: 0
})

test('취소 후 next를 다시 호출하지 않아도 get으로 cancelled 상태를 확인한다', async (t) => {
  const { ctx } = await setup(t, { events: reply, holdAfter: 1 }, databasePath(t))
  const controller = new globalThis.AbortController()
  const iterator = ctx.generation.run(request(), { signal: controller.signal }) as AsyncIterableIterator<AGUIEvent>
  await iterator.next()

  controller.abort(new Error('cancelled by client'))
  expect((await ctx.generation.get('run'))?.status).toBe('cancelled')
})

test('next가 대기 중일 때 return을 호출하면 스트림을 중단하고 interrupted로 확정한다', async (t) => {
  const { ctx, held } = await setup(t, { events: reply, holdAfter: 2 }, databasePath(t))
  const iterator = ctx.generation.run(request()) as AsyncIterableIterator<AGUIEvent>
  await iterator.next()
  await iterator.next()
  await iterator.next()

  const pending = iterator.next()
  await held
  const returned = iterator.return?.(undefined)
  await expect(pending).rejects.toThrow('stopped')
  await returned

  expect((await ctx.generation.get('run'))?.status).toBe('interrupted')
})

test('재등록 뒤 recover가 부분 응답을 interrupted로 확정하고 LLM을 다시 호출하지 않는다', async (t) => {
  const path = databasePath(t)
  const first = await setup(t, { events: reply, holdAfter: 2 }, path)
  const controller = new globalThis.AbortController()
  const running = collect(first.ctx.generation.run(request(), { signal: controller.signal }))
  await first.held

  // 서비스가 해제되면 실행 중이던 기록은 종료를 확정하지 않고 남는다.
  await first.fibers[1]?.dispose()
  await running.catch(() => {})

  const second = await setup(t, { events: reply }, path)
  const recovered = await second.ctx.generation.recover()

  expect(statuses(recovered)).toEqual(['interrupted'])
  expect(recovered[0]?.messages).toEqual([{ id: 'reply', role: 'assistant', content: 'hello' }])
  expect(second.calls).toEqual([])
  expect(statuses(await second.ctx.generation.recover())).toEqual(['interrupted'])
})

test('임차가 유효한 다른 서비스의 실행은 복구 시 running 상태를 유지한다', async (t) => {
  const path = databasePath(t)
  const first = await setup(t, { events: reply, holdAfter: 2 }, path)
  const controller = new globalThis.AbortController()
  const running = collect(first.ctx.generation.run(request(), { signal: controller.signal }))
  await first.held

  const second = await setup(t, { events: reply }, path)
  expect(statuses(await second.ctx.generation.recover())).toEqual(['running'])

  controller.abort(new Error('cancelled by client'))
  await running.catch(() => {})
  expect((await second.ctx.generation.get('run'))?.status).toBe('cancelled')
})

test('임차가 만료된 실행은 recover가 interrupted로 확정한다', async (t) => {
  const path = databasePath(t)
  const first = await setup(t, { events: reply, holdAfter: 2 }, path)
  const controller = new globalThis.AbortController()
  const running = collect(first.ctx.generation.run(request(), { signal: controller.signal }))
  await first.held

  // 실행 중인 프로세스가 임차를 연장하지 못한 상황을 만든다.
  const writer = new DatabaseSync(path)
  try {
    writer.prepare('UPDATE runs SET lease_expires_at = 0 WHERE run_id = ?').run('run')
  } finally {
    writer.close()
  }

  const second = await setup(t, { events: reply }, path)
  expect(statuses(await second.ctx.generation.recover())).toEqual(['interrupted'])

  controller.abort(new Error('cancelled by client'))
  await running.catch(() => {})
  // 실행을 넘겨받은 뒤에는 원래 서비스가 상태를 바꾸지 않는다.
  expect((await second.ctx.generation.get('run'))?.status).toBe('interrupted')
})

test('중복 runId는 기존 실행 상태를 변경하지 않는다', async (t) => {
  const { ctx } = await setup(t, { events: reply }, databasePath(t))
  const first = ctx.generation.run(request()) as AsyncIterableIterator<AGUIEvent>
  await first.next()

  const duplicate = ctx.generation.run(request()) as AsyncIterableIterator<AGUIEvent>
  await expect(duplicate.next()).rejects.toThrow('already recorded')

  expect((await ctx.generation.get('run'))?.status).toBe('running')
  expect(statuses(await ctx.generation.recover())).toEqual(['running'])

  await first.return?.(undefined)
  expect((await ctx.generation.get('run'))?.status).toBe('interrupted')
})

test('시작하지 않은 중복 실행의 반복자를 취소해도 원본 실행을 변경하지 않는다', async (t) => {
  const { ctx } = await setup(t, { events: reply }, databasePath(t))
  const first = ctx.generation.run(request()) as AsyncIterableIterator<AGUIEvent>
  await first.next()
  await first.next()

  const controller = new globalThis.AbortController()
  const duplicate = ctx.generation.run(request(), { signal: controller.signal }) as AsyncIterableIterator<AGUIEvent>
  controller.abort(new Error('duplicate cancelled'))
  await expect(duplicate.next()).rejects.toThrow('duplicate cancelled')

  expect((await ctx.generation.get('run'))?.status).toBe('running')

  await first.return?.(undefined)
  expect((await ctx.generation.get('run'))?.status).toBe('interrupted')
})

test('return 호출이 실패해도 외부 취소 신호의 리스너를 정리한다', async (t) => {
  const { ctx } = await setup(t, { events: reply }, databasePath(t))
  const controller = new globalThis.AbortController()
  const iterator = ctx.generation.run(request(), { signal: controller.signal }) as AsyncIterableIterator<AGUIEvent>
  await iterator.next()
  await ctx.session.commit({ threadId: 'thread', expectedRevision: 0, messages: [], state: undefined })

  await expect(iterator.return?.(undefined)).rejects.toThrow(/revision conflict/)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

test('커밋 실패는 성공 종료 journal을 노출하지 않고 recover 가능한 interrupted로 남긴다', async (t) => {
  const { ctx } = await setup(t, { events: reply }, databasePath(t))
  const iterator = ctx.generation.run(request())
  await ctx.session.commit({ threadId: 'thread', expectedRevision: 0, messages: [], state: undefined })

  await expect(collect(iterator)).rejects.toThrow(/revision conflict/)

  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('interrupted')
  expect(run?.journal.some((entry) => entry.event.type === EventType.RUN_FINISHED)).toBe(false)
  expect(statuses(await ctx.generation.recover())).toEqual(['interrupted'])
})

test('완료한 실행은 재등록 뒤에도 completed를 유지한다', async (t) => {
  const path = databasePath(t)
  const first = await setup(t, { events: reply }, path)
  await collect(first.ctx.generation.run(request()))
  await first.fibers[1]?.dispose()

  const second = await setup(t, { events: reply }, path)
  expect(statuses(await second.ctx.generation.recover())).toEqual(['completed'])
  expect(statuses(await second.ctx.generation.recover())).toEqual(['completed'])
  expect(await second.ctx.session.get('thread')).toEqual({
    threadId: 'thread',
    revision: 1,
    messages: [{ id: 'reply', role: 'assistant', content: 'hello' }],
    state: undefined
  })
  expect(second.calls).toEqual([])
})

test('실패한 실행은 재등록 뒤에도 failed를 유지한다', async (t) => {
  const path = databasePath(t)
  const first = await setup(t, { events: reply, fail: new Error('openai stream failed') }, path)
  await expect(collect(first.ctx.generation.run(request()))).rejects.toThrow('openai stream failed')
  await first.fibers[1]?.dispose()

  const second = await setup(t, { events: reply }, path)
  expect(statuses(await second.ctx.generation.recover())).toEqual(['failed'])
  expect(statuses(await second.ctx.generation.recover())).toEqual(['failed'])
  expect(second.calls).toEqual([])
})

test('취소한 실행은 재등록 뒤에도 cancelled를 유지한다', async (t) => {
  const path = databasePath(t)
  const first = await setup(t, { events: reply, holdAfter: 1 }, path)
  const controller = new globalThis.AbortController()
  const running = collect(first.ctx.generation.run(request(), { signal: controller.signal }))
  await first.held
  controller.abort(new Error('cancelled by client'))
  await running.catch(() => {})
  await first.fibers[1]?.dispose()

  const second = await setup(t, { events: reply }, path)
  expect(statuses(await second.ctx.generation.recover())).toEqual(['cancelled'])
  expect(statuses(await second.ctx.generation.recover())).toEqual(['cancelled'])
  expect(second.calls).toEqual([])
})
