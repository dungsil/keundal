import { EventType, type AGUIEvent, type ExecutionOptions, type RunAgentInput } from '@keundal/core'
import { TaskService, TaskStore, type TaskRequest, type TaskSnapshot } from '@keundal/task'
import taskMemory, { MemoryTaskService, apply, type MemoryTaskOptions } from '@keundal/task-memory'
import { Context } from 'cordis'
import { expect, test, vi, type TestContext } from 'vitest'

const request = (id: string, parentThreadId = 'parent'): TaskRequest => ({
  input: { threadId: `thread-${id}`, runId: id, state: {}, messages: [], tools: [], context: [] },
  parentThreadId,
  parentRunId: 'parent-run',
  label: `task-${id}`
})

const finished = (input: RunAgentInput): AGUIEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: input.threadId,
  runId: input.runId,
  outcome: { type: 'success' }
})

async function* success(input: RunAgentInput): AsyncGenerator<AGUIEvent> {
  yield finished(input)
}

async function setup(t: TestContext, options: MemoryTaskOptions = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(taskMemory, options)
  const releases: (() => void)[] = []
  const hold = () => {
    const gate = Promise.withResolvers<void>()
    releases.push(() => gate.resolve())
    return gate
  }
  t.onTestFinished(async () => {
    for (const release of releases) release()
    await fiber.dispose()
  })
  return { ctx, tasks: ctx.tasks, fiber, hold }
}

test('플러그인은 TaskService 계약을 ctx.tasks에 등록한다', async (t) => {
  const { tasks } = await setup(t)
  expect(taskMemory).toBe(apply)
  expect(tasks).toBeInstanceOf(TaskService)
  expect(tasks).toBeInstanceOf(MemoryTaskService)
  expect(await tasks.get('missing')).toBeUndefined()
  expect(await tasks.cancel('missing')).toBe(false)
  expect(await tasks.list()).toEqual([])
})

test('영속 저장을 확정한 뒤에만 실행하며 종료 시 대기·실행 작업은 interrupted로 보존한다', async (t) => {
  const saved = new Map<string, TaskSnapshot>()
  class Store extends TaskStore {
    async save(snapshot: TaskSnapshot) {
      saved.set(snapshot.id, { ...snapshot })
    }
    async get(id: string) {
      const task = saved.get(id)
      return task && { ...task }
    }
    async list() {
      return [...saved.values()].map((task) => ({ ...task }))
    }
    async recover() {}
  }
  const store = new Store(new Context())
  const { tasks, hold } = await setup(t, { store, maxActive: 1 })
  const gate = hold()
  const running = await tasks.enqueue(request('running'), async function* (input) {
    expect([...saved.values()][0]?.status).toBe('running')
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'partial', delta: 'saved partial' }
    await gate.promise
    yield finished(input)
  })
  await vi.waitFor(async () => expect((await tasks.get(running.id))?.content).toBe('saved partial'))
  const skipped = vi.fn(success)
  const queued = await tasks.enqueue(request('queued'), skipped)
  expect(saved.get(queued.id)?.status).toBe('queued')
  const draining = tasks.dispose()
  gate.resolve()
  await draining
  expect(await tasks.get(running.id)).toMatchObject({ status: 'interrupted', content: 'saved partial' })
  expect(await tasks.get(queued.id)).toMatchObject({ status: 'interrupted', content: '' })
  expect(skipped).not.toHaveBeenCalled()
  const reopened = new MemoryTaskService(new Context(), { store })
  expect(await reopened.list()).toEqual(await tasks.list())
  expect(await reopened.cancel(running.id)).toBe(false)
  await reopened.dispose()
})

test('등록 상태를 저장하지 못하면 실행하지 않고 저장 오류를 전달한다', async () => {
  class Store extends TaskStore {
    async save(): Promise<void> {
      throw new Error('disk full')
    }
    async get() {
      return undefined
    }
    async list() {
      return []
    }
    async recover() {}
  }
  const tasks = new MemoryTaskService(new Context(), { store: new Store(new Context()) })
  const run = vi.fn(success)
  await expect(tasks.enqueue(request('unsaved'), run)).rejects.toThrow('disk full')
  expect(run).not.toHaveBeenCalled()
  await expect(tasks.list()).rejects.toThrow('disk full')
  await expect(tasks.dispose()).rejects.toThrow('disk full')
})

test('부모 스레드가 달라도 전체 동시 실행 수를 제한하고 FIFO 순서로 시작한다', async (t) => {
  const { tasks, hold } = await setup(t, { maxActive: 2 })
  const gates = [hold(), hold(), hold(), hold()]
  const started: string[] = []
  let active = 0
  let peak = 0
  const run = async function* (input: RunAgentInput): AsyncGenerator<AGUIEvent> {
    started.push(input.runId)
    active++
    peak = Math.max(peak, active)
    try {
      await gates[Number(input.runId)]!.promise
      yield finished(input)
    } finally {
      active--
    }
  }
  const snapshots = []
  for (let i = 0; i < gates.length; i++) snapshots.push(await tasks.enqueue(request(String(i), `parent-${i}`), run))
  expect(started).toEqual(['0', '1'])
  expect((await tasks.list()).map((task) => task.status)).toEqual(['running', 'running', 'queued', 'queued'])

  gates[1]!.resolve()
  await vi.waitFor(() => expect(started).toEqual(['0', '1', '2']))
  gates[0]!.resolve()
  await vi.waitFor(() => expect(started).toEqual(['0', '1', '2', '3']))
  gates[2]!.resolve()
  gates[3]!.resolve()
  await vi.waitFor(async () => expect((await tasks.list()).every((task) => task.status === 'completed')).toBe(true))
  expect(peak).toBe(2)
  expect((await tasks.list()).map((task) => task.id)).toEqual(snapshots.map((task) => task.id))
})

test('기본 동시 실행 수는 8이며 아홉 번째 작업은 대기한다', async (t) => {
  const { tasks, hold } = await setup(t)
  const gate = hold()
  const started: string[] = []
  const run = async function* (input: RunAgentInput): AsyncGenerator<AGUIEvent> {
    started.push(input.runId)
    await gate.promise
    yield finished(input)
  }
  for (let i = 0; i < 9; i++) await tasks.enqueue(request(String(i)), run)
  expect(started).toHaveLength(8)
  expect((await tasks.list())[8]?.status).toBe('queued')
  gate.resolve()
  await vi.waitFor(() => expect(started).toHaveLength(9))
})

test.each([0, -1, 1.5, NaN, Infinity])('maxActive가 양의 정수가 아니면 거부한다: %s', (maxActive) => {
  expect(() => new MemoryTaskService(new Context(), { maxActive })).toThrow('positive integer')
})

test('대기 중인 작업을 취소하면 콜백을 시작하지 않는다', async (t) => {
  const { tasks, hold } = await setup(t, { maxActive: 1 })
  const gate = hold()
  const first = await tasks.enqueue(request('first'), async function* (input) {
    await gate.promise
    yield finished(input)
  })
  const skipped = vi.fn(success)
  const queued = await tasks.enqueue(request('queued'), skipped)
  const next = await tasks.enqueue(request('next'), success)
  expect(await tasks.cancel(queued.id)).toBe(true)
  expect(await tasks.cancel(queued.id)).toBe(false)
  gate.resolve()
  await vi.waitFor(async () => expect((await tasks.get(next.id))?.status).toBe('completed'))
  expect((await tasks.get(first.id))?.status).toBe('completed')
  expect((await tasks.get(queued.id))?.status).toBe('cancelled')
  expect(skipped).not.toHaveBeenCalled()
  expect(await tasks.cancel(next.id)).toBe(false)
})

test('실행 취소는 작업별 signal에만 전달하고 형제 작업은 계속 실행한다', async (t) => {
  const { tasks, hold } = await setup(t, { maxActive: 2 })
  const signals: AbortSignal[] = []
  const secondGate = hold()
  const run = async function* (input: RunAgentInput, options: ExecutionOptions): AsyncGenerator<AGUIEvent> {
    const signal = options.signal!
    signals.push(signal)
    expect(Object.keys(options)).toEqual(['signal'])
    if (input.runId === 'first') {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      signal.throwIfAborted()
    } else {
      await secondGate.promise
    }
    yield finished(input)
  }
  const first = await tasks.enqueue(request('first'), run)
  const second = await tasks.enqueue(request('second'), run)
  expect(signals[0]).not.toBe(signals[1])
  expect(await tasks.cancel(first.id)).toBe(true)
  expect(signals[0]?.aborted).toBe(true)
  expect(signals[1]?.aborted).toBe(false)
  expect((await tasks.get(second.id))?.status).toBe('running')
  secondGate.resolve()
  await vi.waitFor(async () => expect((await tasks.get(second.id))?.status).toBe('completed'))
  expect((await tasks.get(first.id))?.status).toBe('cancelled')
})

test('취소 뒤 늦은 완료가 상태를 되살리지 않고 runner 정리 전에는 실행 자리를 반환하지 않는다', async (t) => {
  const { tasks, hold } = await setup(t, { maxActive: 1 })
  const gate = hold()
  const cleanup = hold()
  const cleaning = Promise.withResolvers<void>()
  const first = await tasks.enqueue(request('first'), async function* (input) {
    try {
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'partial' }
      await gate.promise
      yield finished(input)
    } finally {
      cleaning.resolve()
      await cleanup.promise
    }
  })
  await vi.waitFor(async () => expect((await tasks.get(first.id))?.content).toBe('partial'))
  const nextRun = vi.fn(success)
  const next = await tasks.enqueue(request('next'), nextRun)
  await tasks.cancel(first.id)
  const cancelled = await tasks.get(first.id)
  expect((await tasks.get(next.id))?.status).toBe('queued')
  expect(nextRun).not.toHaveBeenCalled()
  gate.resolve()
  await cleaning.promise
  expect(nextRun).not.toHaveBeenCalled()
  expect(await tasks.get(first.id)).toEqual(cancelled)
  cleanup.resolve()
  await vi.waitFor(async () => expect((await tasks.get(next.id))?.status).toBe('completed'))
  expect(await tasks.get(first.id)).toEqual(cancelled)
})

test('어시스턴트 메시지만 순서대로 조립하며 성공한 RUN_FINISHED 뒤에 완료한다', async (t) => {
  const { tasks } = await setup(t)
  const task = await tasks.enqueue(request('content'), async function* (input) {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'one', role: 'assistant' }
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'one', delta: 'hello' }
    yield { type: EventType.REASONING_MESSAGE_START, messageId: 'reason', role: 'reasoning' }
    yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'reason', delta: 'private' }
    yield { type: EventType.TOOL_CALL_RESULT, messageId: 'tool', toolCallId: 'call', content: 'tool output' }
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'two', delta: ' world' }
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'two', delta: '!' }
    yield finished(input)
  })
  await vi.waitFor(async () => expect((await tasks.get(task.id))?.status).toBe('completed'))
  expect((await tasks.get(task.id))?.content).toBe('hello world!')
  expect((await tasks.get(task.id))?.error).toBeUndefined()
})

for (const mode of [
  'throw',
  'non-error',
  'run-error',
  'empty-error',
  'missing-finish',
  'non-success',
  'throw-after-finish'
]) {
  test(`부분 응답 뒤 ${mode} 오류가 발생하면 내용을 보존하고 실패한다`, async (t) => {
    const { tasks } = await setup(t)
    const task = await tasks.enqueue(request(mode), async function* (input) {
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'partial' }
      if (mode === 'throw') throw new Error('runner failed')
      if (mode === 'non-error') await Promise.reject(Object.create(null))
      if (mode === 'run-error' || mode === 'empty-error') {
        yield { type: EventType.RUN_ERROR, message: mode === 'empty-error' ? '' : 'provider failed' }
        yield finished(input)
      }
      if (mode === 'non-success') {
        yield {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
          outcome: { type: 'interrupt', interrupts: [] }
        }
      }
      if (mode === 'throw-after-finish') {
        yield finished(input)
        throw new Error('late failure')
      }
    })
    await vi.waitFor(async () => expect((await tasks.get(task.id))?.status).toBe('failed'))
    expect((await tasks.get(task.id))?.content).toBe('partial')
    expect((await tasks.get(task.id))?.error).toBeTypeOf('string')
  })
}

test('콜백의 동기 예외와 비동기 거부를 처리한 뒤 다음 작업을 실행한다', async (t) => {
  const { tasks } = await setup(t, { maxActive: 1 })
  const synchronous = await tasks.enqueue(request('sync'), () => {
    throw new Error('sync failure')
  })
  const asynchronous = await tasks.enqueue(request('async'), async function* (input) {
    await Promise.reject(new Error('async failure'))
    yield finished(input)
  })
  const next = await tasks.enqueue(request('next'), success)
  await vi.waitFor(async () => expect((await tasks.get(next.id))?.status).toBe('completed'))
  expect(await tasks.get(synchronous.id)).toMatchObject({ status: 'failed', error: 'sync failure' })
  expect(await tasks.get(asynchronous.id)).toMatchObject({ status: 'failed', error: 'async failure' })
})

for (const lifecycle of ['explicit', 'plugin'] as const) {
  test(`${lifecycle} 종료는 모든 작업을 취소하고 runner 정리가 끝날 때까지 기다린다`, async (t) => {
    const { tasks, fiber, hold } = await setup(t, { maxActive: 2 })
    const gates = [hold(), hold()]
    const signals: AbortSignal[] = []
    const closed: string[] = []
    const run = async function* (input: RunAgentInput, options: ExecutionOptions): AsyncGenerator<AGUIEvent> {
      signals.push(options.signal!)
      try {
        await gates[Number(input.runId)]!.promise
        if (options.signal!.aborted) throw new Error('late rejection after cancellation')
        yield finished(input)
      } finally {
        closed.push(input.runId)
      }
    }
    await tasks.enqueue(request('0'), run)
    await tasks.enqueue(request('1'), run)
    const skipped = vi.fn(success)
    await tasks.enqueue(request('queued'), skipped)
    let disposed = false
    const draining = (lifecycle === 'explicit' ? tasks.dispose() : fiber.dispose()).then(() => {
      disposed = true
    })
    await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true))
    await expect(tasks.enqueue(request('rejected'), success)).rejects.toThrow('disposed')
    expect((await tasks.list()).map((task) => task.status)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(disposed).toBe(false)
    gates[0]!.resolve()
    await vi.waitFor(() => expect(closed).toEqual(['0']))
    expect(disposed).toBe(false)
    gates[1]!.resolve()
    await draining
    expect(closed).toEqual(['0', '1'])
    expect(disposed).toBe(true)
    expect(skipped).not.toHaveBeenCalled()
    await tasks.dispose()
  })
}

test('enqueue와 get과 list의 스냅숏 및 대기 입력은 외부 변경과 격리된다', async (t) => {
  const { tasks, hold } = await setup(t, { maxActive: 1 })
  const gate = hold()
  await tasks.enqueue(request('first', 'other-parent'), async function* (input) {
    await gate.promise
    yield finished(input)
  })
  const original = request('isolated')
  original.input.messages.push({ id: 'message', role: 'user', content: 'original' })
  const received: RunAgentInput[] = []
  const task = await tasks.enqueue(original, async function* (input) {
    received.push(input)
    yield finished(input)
  })
  const id = task.id
  task.status = 'completed'
  task.content = 'changed enqueue result'
  original.input.messages[0]!.content = 'changed input'
  original.input.threadId = 'changed thread'
  const copy = (await tasks.get(id))!
  copy.label = 'changed get result'
  copy.content = 'changed get result'
  const listed = await tasks.list({ parentThreadId: 'parent' })
  expect(listed).toHaveLength(1)
  listed[0]!.parentThreadId = 'changed list result'
  listed.length = 0
  expect(await tasks.get(id)).toMatchObject({
    id,
    status: 'queued',
    threadId: 'thread-isolated',
    runId: 'isolated',
    parentThreadId: 'parent',
    parentRunId: 'parent-run',
    label: 'task-isolated',
    content: '',
    createdAt: expect.any(Number),
    updatedAt: expect.any(Number)
  })
  expect(await tasks.list({ parentThreadId: 'missing' })).toEqual([])
  gate.resolve()
  await vi.waitFor(async () => expect((await tasks.get(id))?.status).toBe('completed'))
  expect(received[0]?.threadId).toBe('thread-isolated')
  expect(received[0]?.messages[0]?.content).toBe('original')
  expect(copy.status).toBe('queued')
})
