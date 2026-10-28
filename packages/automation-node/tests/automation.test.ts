import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AutomationDefinition } from '@keundal/automation'
import { NodeAutomationService, type NodeAutomationOptions } from '@keundal/automation-node'
import { EventType, type AGUIEvent, type RunAgentInput } from '@keundal/core'
import { SqliteAutomationStore, SqliteStore, SqliteTaskStore } from '@keundal/plugin-store-sqlite'
import { MemoryTaskService } from '@keundal/task-memory'
import { Context } from 'cordis'
import { expect, test, vi, type TestContext } from 'vitest'

const definition: AutomationDefinition = {
  label: 'Daily summary',
  enabled: true,
  trigger: { type: 'webhook' },
  input: { state: {}, tools: [], context: [], messages: [{ id: 'prompt', role: 'user', content: 'Summarize' }] }
}

async function* success(input: RunAgentInput): AsyncGenerator<AGUIEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'saved result' }
  yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
  yield { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: 'success' } }
}

async function setup(t: TestContext, path = ':memory:', run: NodeAutomationOptions['run'] = success) {
  const ctx = new Context()
  const database = new SqliteStore(path)
  const fiber = await ctx.plugin(async (owned) => {
    new SqliteTaskStore(owned, database)
    new SqliteAutomationStore(owned, database)
    new MemoryTaskService(owned, { store: owned.taskStore })
  })
  const scheduler = new NodeAutomationService(ctx, { store: ctx.automationStore, tasks: ctx.tasks, run })
  await scheduler.start()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await scheduler.dispose()
    await ctx.tasks.dispose()
    await fiber.dispose()
    database.release()
  }
  t.onTestFinished(close)
  return { scheduler, ctx, close }
}

test('동시에 재전송한 Webhook은 한 작업만 만들고 결과와 중복 수신 이력을 재시작 뒤에도 유지한다', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-automation-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const first = await setup(t, path)
  await first.scheduler.put('summary', definition)
  const [a, b] = await Promise.all([
    first.scheduler.webhook('summary', { id: 'delivery-1', payload: { branch: 'main' } }),
    first.scheduler.webhook('summary', { id: 'delivery-1', payload: { branch: 'main' } })
  ])
  expect(a[0]?.taskId).toBe(b[0]?.taskId)
  await expect.poll(async () => (await first.scheduler.history('summary'))[0]?.task?.status).toBe('completed')
  expect(await first.ctx.tasks.list()).toHaveLength(1)
  // Model a crash between durable task submission and saving its link in the attempt.
  const attempt = (await first.ctx.automationStore.attempts('summary'))[0]!
  const { taskId: _taskId, ...claimed } = attempt
  await first.ctx.automationStore.saveAttempt({ ...claimed, status: 'dispatching' })
  await first.close()
  const second = await setup(t, path)
  expect(await second.scheduler.list()).toEqual([expect.objectContaining({ id: 'summary' })])
  const replay = await second.scheduler.webhook('summary', { id: 'delivery-1' })
  expect(replay[0]).toMatchObject({ taskId: a[0]?.taskId, task: { status: 'completed', content: 'saved result' } })
  expect(await second.ctx.tasks.list()).toHaveLength(1)
  await second.close()
})

test('Cron은 지정한 시간대의 경계에서 타이머로 실행하고 누락된 여러 일정을 한 번으로 합친다', async (t) => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  t.onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(new Date('2026-10-28T23:59:59Z'))
  const { scheduler, ctx, close } = await setup(t)
  const schedule = await scheduler.put('morning', {
    ...definition,
    trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Seoul' }
  })
  expect(schedule.nextRunAt).toBe(Date.parse('2026-10-29T00:00:00Z'))
  await scheduler.tick()
  expect(await ctx.tasks.list()).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1000)
  await expect.poll(async () => (await scheduler.history())[0]?.task?.status).toBe('completed')
  expect(await ctx.tasks.list()).toHaveLength(1)
  vi.setSystemTime(new Date('2026-11-02T02:00:00Z'))
  await Promise.all([scheduler.tick(), scheduler.tick()])
  expect(await ctx.tasks.list()).toHaveLength(2)
  expect((await scheduler.list())[0]?.nextRunAt).toBe(Date.parse('2026-11-03T00:00:00Z'))
  await close()
})

test('이벤트 이름과 활성 상태를 구분하고 수신 데이터를 새 작업의 입력에 전달한다', async (t) => {
  const inputs: RunAgentInput[] = []
  const { scheduler } = await setup(t, ':memory:', async function* (input) {
    inputs.push(input)
    yield* success(input)
  })
  await scheduler.put('match', { ...definition, trigger: { type: 'event', name: 'build.failed' } })
  await scheduler.put('other', { ...definition, trigger: { type: 'event', name: 'build.completed' } })
  await scheduler.put('disabled', { ...definition, enabled: false, trigger: { type: 'event', name: 'build.failed' } })
  const attempts = await scheduler.emit('build.failed', { id: 'build-23', payload: { code: 23 } })
  expect(attempts).toHaveLength(1)
  expect(attempts[0]?.automationId).toBe('match')
  await expect.poll(() => inputs.length).toBe(1)
  expect(inputs[0]?.messages.at(-1)?.content).toContain('{"code":23}')
  expect(await scheduler.webhook('match', { id: 'wrong-trigger' })).toEqual([])
  await scheduler.delete('match')
  expect(await scheduler.emit('build.failed', { id: 'next-build' })).toEqual([])
  expect(await scheduler.history('match')).toHaveLength(1)
})

test('실행 중인 자동화는 겹쳐 실행하지 않고 중단된 작업을 복구하되 다시 실행하지 않는다', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-automation-interrupted-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const first = await setup(t, path, async function* (input, options) {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' }
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'partial', delta: 'partial result' }
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    yield* success(input)
  })
  await first.scheduler.put('slow', definition)
  await first.scheduler.webhook('slow', { id: 'first' })
  await expect.poll(async () => (await first.scheduler.history())[0]?.task?.content).toBe('partial result')
  expect((await first.scheduler.webhook('slow', { id: 'second' }))[0]?.status).toBe('skipped')
  await first.close()
  const second = await setup(t, path)
  expect((await second.scheduler.history())[0]?.task).toMatchObject({
    status: 'interrupted',
    content: 'partial result'
  })
  await second.scheduler.webhook('slow', { id: 'first' })
  expect(await second.ctx.tasks.list()).toHaveLength(1)
  await second.close()
})

test('실행 실패는 TaskService 결과에 기록하고 같은 수신 ID로 다시 실행하지 않는다', async (t) => {
  const { scheduler, ctx } = await setup(t, ':memory:', async function* () {
    yield { type: EventType.RUN_ERROR, message: 'provider unavailable' }
  })
  await scheduler.put('failure', definition)
  await scheduler.webhook('failure', { id: 'failed-delivery' })
  await expect.poll(async () => (await scheduler.history())[0]?.task?.status).toBe('failed')
  expect((await scheduler.history())[0]?.task?.error).toBe('provider unavailable')
  await scheduler.webhook('failure', { id: 'failed-delivery' })
  expect(await ctx.tasks.list()).toHaveLength(1)
})

test('취소 상태를 저장해도 실행 정리가 끝날 때까지 다음 자동화 작업을 시작하지 않는다', async (t) => {
  const cleanup = Promise.withResolvers<void>()
  const { scheduler, ctx } = await setup(t, ':memory:', async function* (input, options) {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' }
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'partial', delta: 'running' }
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    await cleanup.promise
    yield* success(input)
  })
  try {
    await scheduler.put('cancelled', definition)
    const [first] = await scheduler.webhook('cancelled', { id: 'first' })
    await expect.poll(async () => (await ctx.tasks.get(first!.taskId!))?.content).toBe('running')
    await ctx.tasks.cancel(first!.taskId!)
    expect((await ctx.tasks.get(first!.taskId!))?.status).toBe('cancelled')
    expect((await scheduler.webhook('cancelled', { id: 'during-cleanup' }))[0]?.status).toBe('skipped')
    expect(await ctx.tasks.list()).toHaveLength(1)
  } finally {
    cleanup.resolve()
  }
})

test('잘못된 Cron과 시간대 및 수신 ID는 등록이나 실행 전에 거부한다', async (t) => {
  const { scheduler, ctx } = await setup(t)
  for (const trigger of [
    { type: 'cron' as const, expression: '61 * * * *', timezone: 'UTC' },
    { type: 'cron' as const, expression: '* * * * *', timezone: 'Invalid/Zone' },
    { type: 'cron' as const, expression: '* * * * * *', timezone: 'UTC' }
  ])
    await expect(scheduler.put('invalid', { ...definition, trigger })).rejects.toThrow()
  expect(await scheduler.list()).toEqual([])
  await scheduler.put('valid', definition)
  await expect(scheduler.webhook('valid', { id: '' })).rejects.toThrow('event ID')
  expect(await ctx.tasks.list()).toEqual([])
})

test('작업 제출 전 기록만 남은 수신은 interrupted로 복구하고 재전송해도 실행하지 않는다', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-automation-claim-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const { scheduler, ctx, close } = await setup(t, path)
  await scheduler.put('claimed', definition)
  await ctx.automationStore.claim({
    id: 'claim',
    automationId: 'claimed',
    key: 'event:delivery',
    runId: 'missing-run',
    status: 'dispatching',
    createdAt: Date.now()
  })
  await close()
  const second = await setup(t, path)
  expect((await second.scheduler.webhook('claimed', { id: 'delivery' }))[0]?.status).toBe('interrupted')
  expect(await second.ctx.tasks.list()).toEqual([])
  await second.close()
})
