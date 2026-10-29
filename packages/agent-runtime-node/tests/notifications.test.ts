import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventType } from '@keundal/core'
import { expect, test, vi } from 'vitest'

import { createAgentRuntime, createNodeComposition } from '../src/index.js'

test('UI 연결 없이 Cron 결과와 실패·중단을 Webhook으로 전달하고 호스트 재시작 뒤 중복 발송하지 않는다', async (t) => {
  const results: { id: string; type: string; automationId: string; content: string; error?: string }[] = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    results.push(JSON.parse(Buffer.concat(chunks).toString()))
    expect(request.headers['idempotency-key']).toBe(results.at(-1)?.id)
    expect(request.headers.authorization).toBe('Bearer receiver-test-token')
    response.writeHead(204).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address() as { port: number }
  const directory = mkdtempSync(join(tmpdir(), 'keundal-host-notifications-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const open = async () => {
    const host = await createAgentRuntime(
      {
        KEUNDAL_PROVIDER: 'openai',
        KEUNDAL_MODEL: 'test',
        KEUNDAL_SQLITE_PATH: join(directory, 'store.sqlite'),
        KEUNDAL_WORKSPACE_ROOT: join(directory, 'workspaces'),
        KEUNDAL_API_TOKEN: 'host-test-token',
        KEUNDAL_NOTIFICATION_WEBHOOK_URL: `http://127.0.0.1:${address.port}/results`,
        KEUNDAL_NOTIFICATION_WEBHOOK_TOKEN: 'receiver-test-token'
      },
      { compose: createNodeComposition, subagents: false }
    )
    t.onTestFinished(() => host.dispose())
    host.ctx.llm.countTokens = async () => 20
    host.ctx.llm.stream = async function* (request, options) {
      const command = request.input.messages[0]?.content
      if (command === 'fail') throw new Error('provider unavailable')
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'scheduled result' }
      if (command === 'interrupt') {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve()
          else options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
    }
    return host
  }
  const host = await open()
  // Only Date is simulated: host timers, task execution, SQLite and outbound HTTP are real.
  vi.useFakeTimers({ toFake: ['Date'] })
  t.onTestFinished(() => {
    vi.useRealTimers()
  })
  vi.setSystemTime(new Date('2026-10-29T00:00:59Z'))
  const input = (content: string) => ({
    state: {},
    tools: [],
    context: [],
    messages: [{ id: 'prompt', role: 'user' as const, content }]
  })
  await host.services.automation!.put('cron', {
    label: 'Scheduled',
    enabled: true,
    trigger: { type: 'cron', expression: '* * * * *', timezone: 'Asia/Seoul' },
    input: input('complete')
  })
  vi.setSystemTime(new Date('2026-10-29T00:01:00Z'))
  await expect
    .poll(() => results.find((result) => result.automationId === 'cron'), { timeout: 8000 })
    .toMatchObject({
      type: 'automation.completed',
      content: 'scheduled result'
    })
  await host.services.automation!.delete('cron')
  for (const command of ['fail', 'interrupt']) {
    await host.services.automation!.put(command, {
      label: command,
      enabled: true,
      trigger: { type: 'webhook' },
      input: input(command)
    })
    await host.services.automation!.webhook(command, { id: command })
  }
  await expect
    .poll(() => results.find((result) => result.automationId === 'fail'), { timeout: 8000 })
    .toMatchObject({
      type: 'automation.failed',
      error: 'provider unavailable'
    })
  await expect
    .poll(async () => (await host.services.automation!.history('interrupt'))[0]?.task?.content)
    .toBe('scheduled result')
  await host.dispose()
  const restarted = await open()
  await expect
    .poll(() => results.find((result) => result.automationId === 'interrupt'), { timeout: 8000 })
    .toMatchObject({
      type: 'automation.interrupted',
      content: 'scheduled result'
    })
  await restarted.dispose()
  const third = await open()
  await new Promise((resolve) => globalThis.setTimeout(resolve, 2200))
  expect(results).toHaveLength(3)
  expect(new Set(results.map((result) => result.id)).size).toBe(3)
  await third.dispose()
}, 25_000)
