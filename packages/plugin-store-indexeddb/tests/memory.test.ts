import type { MemoryDraft } from '@keundal/memory'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import { Context } from 'cordis'
import { IDBFactory } from 'fake-indexeddb'
import { expect, test } from 'vitest'

const draft: MemoryDraft = {
  scope: { type: 'project', id: 'project' },
  content: '한국어 답변 선호',
  source: { label: '사용자 요청', threadId: 'origin', messageId: 'message' }
}

test('기억 전용 objectstore를 다시 열어 scope와 출처와 수정과 삭제를 유지한다', async (t) => {
  const indexedDB = new IDBFactory()
  const config = { indexedDB, databaseName: 'memory' }
  const ctx = new Context()
  const first = await ctx.plugin(indexedDBStorePlugin, config)
  t.onTestFinished(() => first.dispose())
  const entry = await ctx.memory.save(draft)
  const global = await ctx.memory.save({ ...draft, scope: { type: 'user' } })
  await ctx.memory.save({ ...draft, scope: { type: 'conversation', id: 'other' } })
  expect(await ctx.session.list()).toEqual([])
  await first.dispose()
  const second = await ctx.plugin(indexedDBStorePlugin, config)
  t.onTestFinished(() => second.dispose())
  expect((await ctx.memory.list()).find(({ id }) => id === entry.id)).toEqual(entry)
  expect((await ctx.memory.search({ text: '한국어' })).map(({ id }) => id)).toEqual([global.id])
  const updated = await ctx.memory.save({ ...draft, content: '수정한 한국어 선호' }, entry.id)
  expect(updated.createdAt).toBe(entry.createdAt)
  expect(updated.source).toEqual(entry.source)
  const options = { signal: AbortSignal.abort() }
  await expect(ctx.memory.list(options)).rejects.toThrow()
  await expect(ctx.memory.save(draft, undefined, options)).rejects.toThrow()
  await expect(ctx.memory.delete(entry.id, options)).rejects.toThrow()
  await ctx.memory.delete(global.id)
  await second.dispose()
  const third = await ctx.plugin(indexedDBStorePlugin, config)
  t.onTestFinished(() => third.dispose())
  const persisted = await ctx.memory.list()
  expect(persisted.find(({ id }) => id === entry.id)).toEqual(updated)
  expect(persisted.some(({ id }) => id === global.id)).toBe(false)
  await expect(ctx.memory.save(draft, global.id)).rejects.toThrow(/does not exist/)
})

test('v1의 세션과 실행과 journal을 보존하며 기억 objectstore만 추가한다', async (t) => {
  const indexedDB = new IDBFactory()
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('upgrade', 1)
    opening.onerror = () => reject(opening.error)
    opening.onupgradeneeded = () => {
      const db = opening.result
      db.createObjectStore('threads', { keyPath: 'threadId' })
      db.createObjectStore('runs', { keyPath: 'runId' })
      db.createObjectStore('journal', { keyPath: ['runId', 'sequence'] }).createIndex('by-run', 'runId')
    }
    opening.onsuccess = () => resolve(opening.result)
  })
  const thread = { threadId: 'existing', revision: 3, messages: [], state: { preserved: true } }
  const run = { runId: 'run', threadId: 'existing', status: 'interrupted', nextSequence: 1, request: { marker: 'v1' } }
  const journal = { runId: 'run', sequence: 0, event: { type: 'RUN_STARTED', threadId: 'existing', runId: 'run' } }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['threads', 'runs', 'journal'], 'readwrite')
    transaction.objectStore('threads').put(thread)
    transaction.objectStore('runs').put(run)
    transaction.objectStore('journal').put(journal)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
  const ctx = new Context()
  const fiber = await ctx.plugin(indexedDBStorePlugin, { indexedDB, databaseName: 'upgrade' })
  t.onTestFinished(() => fiber.dispose())
  await ctx.memory.save(draft)
  expect(await ctx.session.get('existing')).toEqual(thread)
  const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('upgrade')
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
  try {
    expect(upgraded.version).toBe(2)
    const transaction = upgraded.transaction(['runs', 'journal', 'memories'], 'readonly')
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    expect(await read(transaction.objectStore('runs').get('run'))).toEqual(run)
    expect(await read(transaction.objectStore('journal').get(['run', 0]))).toEqual(journal)
    expect(await read(transaction.objectStore('memories').count())).toBe(1)
  } finally {
    upgraded.close()
  }
})

test('진행 중인 IndexedDB 쓰기를 취소하면 기억 행을 확정하지 않는다', async (t) => {
  const indexedDB = new IDBFactory()
  const ctx = new Context()
  const fiber = await ctx.plugin(indexedDBStorePlugin, { indexedDB, databaseName: 'abort' })
  t.onTestFinished(() => fiber.dispose())
  await ctx.memory.list()
  const controller = new AbortController()
  const original = indexedDB.open.bind(indexedDB)
  // A real transaction is aborted synchronously from the first write request.
  const probe = await new Promise<IDBDatabase>((resolve) => {
    const opening = original('abort')
    opening.onsuccess = () => resolve(opening.result)
  })
  const objectStorePrototype = Object.getPrototypeOf(
    probe.transaction('memories').objectStore('memories')
  ) as IDBObjectStore
  const put = objectStorePrototype.put
  objectStorePrototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    const request = put.apply(this, args)
    controller.abort(new Error('cancelled write'))
    return request
  }
  try {
    await expect(ctx.memory.save(draft, undefined, { signal: controller.signal })).rejects.toThrow()
    expect(await ctx.memory.list()).toEqual([])
  } finally {
    objectStorePrototype.put = put
    probe.close()
  }
})
