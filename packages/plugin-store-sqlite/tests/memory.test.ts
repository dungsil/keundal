import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { MemoryDraft } from '@keundal/memory'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

const draft: MemoryDraft = {
  scope: { type: 'project', id: 'project' },
  content: '한국어 답변 선호',
  source: { label: '사용자 요청', threadId: 'origin', messageId: 'message' }
}

test('기억 전용 행을 세션 없이 저장하고 SQLite 연결을 다시 열어 수정과 삭제를 유지한다', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-memory-'))
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'store.sqlite')
  const ctx = new Context()
  const first = await ctx.plugin(sqliteStorePlugin, { path })
  t.onTestFinished(() => first.dispose())
  const entry = await ctx.memory.save(draft)
  const global = await ctx.memory.save({ ...draft, scope: { type: 'user' } })
  await ctx.memory.save({ ...draft, scope: { type: 'conversation', id: 'other' } })
  expect(await ctx.session.list()).toEqual([])
  const database = new DatabaseSync(path)
  try {
    expect(database.prepare('SELECT count(*) AS count FROM memories').get()?.count).toBe(3)
    expect(database.prepare('SELECT count(*) AS count FROM threads').get()?.count).toBe(0)
  } finally {
    database.close()
  }
  await first.dispose()
  const second = await ctx.plugin(sqliteStorePlugin, { path })
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
  const third = await ctx.plugin(sqliteStorePlugin, { path })
  t.onTestFinished(() => third.dispose())
  const persisted = await ctx.memory.list()
  expect(persisted.find(({ id }) => id === entry.id)).toEqual(updated)
  expect(persisted.some(({ id }) => id === global.id)).toBe(false)
  await expect(ctx.memory.save(draft, global.id)).rejects.toThrow(/does not exist/)
})
