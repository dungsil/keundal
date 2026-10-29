import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Notification } from '@keundal/notification'
import { WebhookNotificationService } from '@keundal/plugin-notification-webhook'
import { SqliteNotificationStore, SqliteStore } from '@keundal/plugin-store-sqlite'
import { Context } from 'cordis'
import { afterEach, expect, test, vi, type TestContext } from 'vitest'

afterEach(() => {
  vi.useRealTimers()
})

const message: Notification = {
  id: 'automation:attempt-23',
  type: 'automation.completed',
  automationId: 'daily',
  attemptId: 'attempt-23',
  runId: 'run-42',
  content: 'result with a partial response',
  createdAt: 1793232000000
}

async function receiver(t: TestContext, respond: (response: ServerResponse) => void) {
  const requests: { headers: IncomingHttpHeaders; body: Notification }[] = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Notification })
    respond(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/private-destination`, requests }
}

async function sender(t: TestContext, url: string, path = ':memory:') {
  const ctx = new Context()
  const database = new SqliteStore(path)
  const fiber = await ctx.plugin((owned) => {
    new SqliteNotificationStore(owned, database)
  })
  const service = new WebhookNotificationService(ctx, ctx.notificationStore, { url, token: 'test-credential' })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await service.dispose()
    await fiber.dispose()
    database.release()
  }
  t.onTestFinished(close)
  return { service, close }
}

test('503 응답은 지수 지연 뒤 같은 ID와 결과로 재시도하고 재시작 뒤 성공한 알림을 다시 보내지 않는다', async (t) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  let calls = 0
  const target = await receiver(t, (response) => response.writeHead(++calls === 1 ? 503 : 204).end())
  const directory = mkdtempSync(join(tmpdir(), 'keundal-notification-retry-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const first = await sender(t, target.url, path)
  await Promise.all([first.service.notify(message), first.service.notify(message)])
  await Promise.all([first.service.tick(), first.service.tick()])
  expect(target.requests).toHaveLength(1)
  await first.close()
  const second = await sender(t, target.url, path)
  vi.setSystemTime(Date.now() + 999)
  await second.service.tick()
  expect(target.requests).toHaveLength(1)
  vi.setSystemTime(Date.now() + 1)
  await second.service.tick()
  expect(target.requests).toHaveLength(2)
  for (const request of target.requests) {
    expect(request.body).toEqual(message)
    expect(request.headers['idempotency-key']).toBe(message.id)
    expect(request.headers.authorization).toBe('Bearer test-credential')
    expect(request.headers['content-type']).toBe('application/json')
  }
  await second.close()
  const third = await sender(t, target.url, path)
  await third.service.notify(message)
  await third.service.tick()
  expect(target.requests).toHaveLength(2)
  await third.close()
})

for (const status of [400, 302, 408, 429, 500]) {
  test(`${status} 응답은 영구 오류와 재시도 대상을 구분하고 최대 다섯 번만 보낸다`, async (t) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const target = await receiver(t, (response) => response.writeHead(status, { Location: '/redirect' }).end())
    const { service } = await sender(t, target.url)
    await service.notify(message)
    for (let i = 0; i < 8; i++) {
      await service.tick()
      vi.setSystemTime(Date.now() + 60_000)
    }
    expect(target.requests).toHaveLength(status === 400 || status === 302 ? 1 : 5)
    await service.notify(message)
    await service.tick()
    expect(target.requests).toHaveLength(status === 400 || status === 302 ? 1 : 5)
  })
}

test('429의 Retry-After가 지나기 전에는 보내지 않고 지정한 시각에 재시도한다', async (t) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const target = await receiver(t, (response) => response.writeHead(429, { 'Retry-After': '7' }).end())
  const { service } = await sender(t, target.url)
  await service.notify(message)
  await service.tick()
  vi.setSystemTime(Date.now() + 6999)
  await service.tick()
  expect(target.requests).toHaveLength(1)
  vi.setSystemTime(Date.now() + 1)
  await service.tick()
  expect(target.requests).toHaveLength(2)
})

for (const failure of ['disconnect', 'timeout']) {
  test(`${failure} 뒤 다음 시도는 같은 ID로 결과를 전달한다`, async (t) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let calls = 0
    const target = await receiver(t, (response) => {
      if (++calls > 1) response.writeHead(204).end()
      else if (failure === 'disconnect') response.destroy()
    })
    const { service } = await sender(t, target.url)
    await service.notify(message)
    await service.tick()
    expect(target.requests).toHaveLength(1)
    vi.setSystemTime(Date.now() + 1000)
    await service.tick()
    expect(target.requests.map((request) => request.body)).toEqual([message, message])
    await service.tick()
    expect(target.requests).toHaveLength(2)
  }, 15_000)
}

test('종료할 때 응답 없는 전송을 취소하고 다음 호스트에서 같은 ID로 전달을 이어간다', async (t) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  let respond = false
  const target = await receiver(t, (response) => {
    if (respond) response.writeHead(204).end()
  })
  const directory = mkdtempSync(join(tmpdir(), 'keundal-notification-abort-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const first = await sender(t, target.url, path)
  await first.service.notify(message)
  const pending = first.service.tick()
  await expect.poll(() => target.requests.length).toBe(1)
  await first.close()
  await pending
  respond = true
  vi.setSystemTime(Date.now() + 1000)
  const second = await sender(t, target.url, path)
  await second.service.tick()
  expect(target.requests).toHaveLength(2)
  expect(target.requests[1]?.body).toEqual(message)
  await second.close()
})
