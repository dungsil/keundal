import type { MemoryDraft } from '@keundal/memory'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import { Context } from 'cordis'
import { IDBFactory } from 'fake-indexeddb'
import { expect, test } from 'vitest'

const draft: MemoryDraft = {
  scope: { type: 'project', id: 'project' },
  title: '사용자 선호',
  content: '한국어 답변 선호',
  sources: [{ uri: 'keundal://threads/origin', label: '사용자 요청' }]
}

test('기억 전용 objectstore를 다시 열어 scope와 출처와 수정과 삭제를 유지한다', async (t) => {
  const indexedDB = new IDBFactory()
  const config = { indexedDB, databaseName: 'memory' }
  const ctx = new Context()
  const first = await ctx.plugin(indexedDBStorePlugin, config)
  t.onTestFinished(() => first.dispose())
  const entry = await ctx.scopedMemory.save(draft)
  const global = await ctx.scopedMemory.save({ ...draft, scope: { type: 'user' } })
  await ctx.scopedMemory.save({ ...draft, scope: { type: 'conversation', id: 'other' } })
  expect(await ctx.session.list()).toEqual([])
  await first.dispose()
  const second = await ctx.plugin(indexedDBStorePlugin, config)
  t.onTestFinished(() => second.dispose())
  expect((await ctx.scopedMemory.list()).find(({ id }) => id === entry.id)).toEqual(entry)
  expect((await ctx.scopedMemory.search({ text: '한국어' })).map(({ id }) => id)).toEqual([global.id])
  const updated = await ctx.scopedMemory.save({ ...draft, content: '수정한 한국어 선호' }, entry.id, entry.revision)
  expect(updated.createdAt).toBe(entry.createdAt)
  expect(updated.sources).toEqual(entry.sources)
  const options = { signal: AbortSignal.abort() }
  await expect(ctx.scopedMemory.list(options)).rejects.toThrow()
  await expect(ctx.scopedMemory.save(draft, undefined, undefined, options)).rejects.toThrow()
  await expect(ctx.scopedMemory.delete(entry.id, updated.revision, options)).rejects.toThrow()
  await ctx.scopedMemory.delete(global.id, global.revision)
  await second.dispose()
  const third = await ctx.plugin(indexedDBStorePlugin, config)
  t.onTestFinished(() => third.dispose())
  const persisted = await ctx.scopedMemory.list()
  expect(persisted.find(({ id }) => id === entry.id)).toEqual(updated)
  expect(persisted.some(({ id }) => id === global.id)).toBe(false)
  await expect(ctx.scopedMemory.save(draft, global.id, global.revision)).rejects.toThrow(/does not exist/)
})

for (const version of [1, 2])
  test(`v${version}의 세션과 실행과 journal과 작업을 보존하며 기억 objectstore를 추가한다`, async (t) => {
    const indexedDB = new IDBFactory()
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('upgrade', version)
      opening.onerror = () => reject(opening.error)
      opening.onupgradeneeded = () => {
        const db = opening.result
        db.createObjectStore('threads', { keyPath: 'threadId' })
        db.createObjectStore('runs', { keyPath: 'runId' })
        db.createObjectStore('journal', { keyPath: ['runId', 'sequence'] }).createIndex('by-run', 'runId')
        if (version === 2) db.createObjectStore('tasks', { keyPath: 'id' })
      }
      opening.onsuccess = () => resolve(opening.result)
    })
    const thread = { threadId: 'existing', revision: 3, messages: [], state: { preserved: true } }
    const run = {
      runId: 'run',
      threadId: 'existing',
      status: 'interrupted',
      nextSequence: 1,
      request: { marker: 'v1' }
    }
    const journal = { runId: 'run', sequence: 0, event: { type: 'RUN_STARTED', threadId: 'existing', runId: 'run' } }
    const task = { id: 'existing-task', parentThreadId: 'existing', status: 'completed' }
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        ['threads', 'runs', 'journal', ...(version === 2 ? ['tasks'] : [])],
        'readwrite'
      )
      transaction.objectStore('threads').put(thread)
      transaction.objectStore('runs').put(run)
      transaction.objectStore('journal').put(journal)
      if (version === 2) transaction.objectStore('tasks').put(task)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
    const ctx = new Context()
    const fiber = await ctx.plugin(indexedDBStorePlugin, { indexedDB, databaseName: 'upgrade' })
    t.onTestFinished(() => fiber.dispose())
    await ctx.scopedMemory.save(draft)
    expect(await ctx.session.get('existing')).toEqual(thread)
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('upgrade')
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error)
    })
    try {
      expect(upgraded.version).toBe(3)
      const transaction = upgraded.transaction(['runs', 'journal', 'memories', 'tasks'], 'readonly')
      const read = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      expect(await read(transaction.objectStore('runs').get('run'))).toEqual(run)
      expect(await read(transaction.objectStore('journal').get(['run', 0]))).toEqual(journal)
      expect(await read(transaction.objectStore('memories').count())).toBe(1)
      expect(await read(transaction.objectStore('tasks').get('existing-task'))).toEqual(
        version === 2 ? task : undefined
      )
    } finally {
      upgraded.close()
    }
  })

test('진행 중인 IndexedDB 쓰기를 취소하면 기억 행을 확정하지 않는다', async (t) => {
  const indexedDB = new IDBFactory()
  const ctx = new Context()
  const fiber = await ctx.plugin(indexedDBStorePlugin, { indexedDB, databaseName: 'abort' })
  t.onTestFinished(() => fiber.dispose())
  await ctx.scopedMemory.list()
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
    await expect(ctx.scopedMemory.save(draft, undefined, undefined, { signal: controller.signal })).rejects.toThrow()
    expect(await ctx.scopedMemory.list()).toEqual([])
  } finally {
    objectStorePrototype.put = put
    probe.close()
  }
})

test('서로 다른 연결의 프로젝트 API와 scopedMemory가 revision을 공유하고 동시 쓰기를 직렬화한다', async (t) => {
  const indexedDB = new IDBFactory()
  const config = { indexedDB, databaseName: 'shared' }
  const ctx = new Context()
  const other = new Context()
  const first = await ctx.plugin(indexedDBStorePlugin, config)
  const second = await other.plugin(indexedDBStorePlugin, config)
  t.onTestFinished(() => first.dispose())
  t.onTestFinished(() => second.dispose())
  const { scope: _scope, ...content } = draft
  const created = await ctx.memory.create('project', content)
  expect((await other.scopedMemory.list())[0]).toMatchObject({ id: created.id, scope: draft.scope, revision: 1 })
  const updated = await other.scopedMemory.save({ ...draft, content: '공유된 내용' }, created.id, 1)
  expect(await ctx.memory.get('project', created.id)).toMatchObject({ content: '공유된 내용', revision: 2 })
  await expect(ctx.memory.update('project', created.id, 1, content)).rejects.toThrow(/revision conflict/)
  await expect(ctx.memory.delete('project', created.id, 1)).rejects.toThrow(/revision conflict/)
  const results = await Promise.allSettled([
    ctx.memory.update('project', created.id, updated.revision, content),
    other.scopedMemory.save({ ...draft, content: '동시 변경' }, created.id, updated.revision)
  ])
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
  expect(await ctx.memory.get('project', created.id)).toMatchObject({ revision: 3 })
  await expect(other.scopedMemory.delete(created.id, 2)).rejects.toThrow(/revision conflict/)
  await other.scopedMemory.delete(created.id, 3)
  expect(await ctx.memory.get('project', created.id)).toBeUndefined()
  const uiCreated = await ctx.scopedMemory.save(draft)
  expect(await other.memory.get('project', uiCreated.id)).toMatchObject({ revision: 1, sources: draft.sources })
  await other.memory.delete('project', uiCreated.id, 1)
  expect(await ctx.scopedMemory.list()).toEqual([])
})
