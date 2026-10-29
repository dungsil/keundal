import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { NotificationDelivery } from '@keundal/notification'
import sqliteStorePlugin, { SqliteNotificationStore } from '@keundal/plugin-store-sqlite'
import { Context, type Fiber } from 'cordis'
import { expect, test } from 'vitest'

test('동시 중복 알림은 대상별로 한 번만 등록하고 재시작 후 pending·delivered·failed 스냅숏을 보존한다', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-notification-'))
  const path = join(directory, 'store.sqlite')
  const fibers: Fiber[] = []
  t.onTestFinished(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  const open = async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(sqliteStorePlugin, { path })
    fibers.push(fiber)
    expect(ctx.notificationStore).toBeInstanceOf(SqliteNotificationStore)
    return { store: ctx.notificationStore, fiber }
  }
  const first = await open()
  const second = await open()
  const pending: NotificationDelivery = {
    notification: {
      id: 'pending',
      type: 'automation.completed',
      automationId: 'automation',
      attemptId: 'attempt',
      runId: 'run',
      taskId: 'task',
      content: 'result',
      createdAt: 100
    },
    target: 'primary',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 100
  }
  expect(
    await Promise.all([
      first.store.claim(pending),
      second.store.claim({ ...pending, attempts: 99 }),
      first.store.claim({ ...pending, status: 'failed' })
    ])
  ).toEqual([true, false, false])
  expect(await second.store.list('primary')).toEqual([pending])

  const otherTarget = { ...structuredClone(pending), target: 'secondary' }
  expect(await second.store.claim(otherTarget)).toBe(true)
  const delivered: NotificationDelivery = {
    ...structuredClone(pending),
    notification: { ...pending.notification, id: 'delivered' },
    status: 'delivered',
    attempts: 1,
    nextAttemptAt: 200
  }
  const failed: NotificationDelivery = {
    ...structuredClone(pending),
    notification: { ...pending.notification, id: 'failed', type: 'automation.failed', error: 'execution_failed' },
    status: 'failed',
    attempts: 3,
    nextAttemptAt: 500,
    error: 'http_503'
  }
  for (const delivery of [delivered, failed]) {
    expect(await first.store.claim({ ...delivery, status: 'pending', attempts: 0 })).toBe(true)
    await second.store.save(delivery)
  }
  const saved = structuredClone([pending, delivered, failed])
  pending.notification.content = 'mutated input'
  delivered.notification.content = 'mutated saved input'
  const listed = await first.store.list('primary')
  expect(listed).toEqual(saved)
  listed[0]!.notification.content = 'mutated output'
  expect(await second.store.list('primary')).toEqual(saved)
  expect(await first.store.list('secondary')).toEqual([otherTarget])
  expect(await first.store.list('missing')).toEqual([])

  await first.fiber.dispose()
  await expect(first.store.claim(pending)).rejects.toThrow('disposed')
  await expect(first.store.save(pending)).rejects.toThrow('disposed')
  await expect(first.store.list('primary')).rejects.toThrow('disposed')
  expect(await second.store.list('primary')).toEqual(saved)
  await second.fiber.dispose()

  const reopened = await open()
  expect(await reopened.store.list('primary')).toEqual(saved)
  expect(await reopened.store.list('secondary')).toEqual([otherTarget])
  expect(await reopened.store.claim(pending)).toBe(false)
  expect(await reopened.store.list('primary')).toEqual(saved)
})
