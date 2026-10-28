import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { MemoryContent } from '@keundal/memory'
import { createMemoryTools } from '@keundal/memory/tools'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-memory-'))
  const path = join(directory, 'store.sqlite')
  const fibers: { dispose(): Promise<void> }[] = []
  t.onTestFinished(async () => {
    for (const fiber of fibers) await fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  const open = async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(sqliteStorePlugin, { path })
    fibers.push(fiber)
    return { ctx, fiber }
  }
  return { path, open, ...(await open()) }
}

const decision: MemoryContent = {
  title: '저장소 설계 결정',
  content: 'SQLite WAL을 사용하고 임베딩은 나중에 도입한다. 목표 적중률 90%.',
  sources: [{ uri: 'https://example.com/adr/7', label: 'ADR-7' }]
}

test('서로 다른 대화의 공개 도구가 재시작 후 같은 프로젝트의 메모리와 출처를 조회한다', async (t) => {
  const { ctx, fiber, open } = await setup(t)
  const context = { threadId: 'first', runId: 'save', toolCallId: 'call', signal: new AbortController().signal }
  const saved = JSON.parse(
    await createMemoryTools(ctx.memory, 'project-a')
      .find((tool) => tool.name === 'memory_save')!
      .execute(decision, context)
  )
  expect(saved.sources).toEqual([
    ...decision.sources,
    { uri: 'keundal://threads/first/runs/save', label: 'Conversation' }
  ])
  await ctx.session.delete('first', 0)
  await fiber.dispose()
  const reopened = await open()
  const tools = createMemoryTools(reopened.ctx.memory, 'project-a')
  const result = JSON.parse(
    await tools
      .find((tool) => tool.name === 'memory_search')!
      .execute({ query: '설계 sqlite' }, { ...context, threadId: 'second', runId: 'search' })
  )
  expect(result).toEqual([saved])
  expect(await reopened.ctx.memory.get('project-a', saved.id)).toEqual(saved)
  expect(await reopened.ctx.memory.get('project-b', saved.id)).toBeUndefined()
  expect(await reopened.ctx.memory.search('project-b', { query: '설계' })).toEqual([])
})

test('검색은 제목과 본문의 모든 검색어를 문자 그대로 찾고 개수 제한을 적용한다', async (t) => {
  const { ctx } = await setup(t)
  const saved = await ctx.memory.create('a', decision)
  await ctx.memory.create('a', { ...decision, title: '다른 설계', content: 'Postgres를 사용한다' })
  await ctx.memory.create('b', decision)
  for (const query of ['설계 sqlite', '90%', '결정 WAL'])
    expect(await ctx.memory.search('a', { query })).toEqual([saved])
  for (const query of ['설계 Postgres SQLite', '%', '_', "' OR 1=1 --", '없는정보'])
    expect(await ctx.memory.search('a', { query })).toEqual(query === '%' ? [saved] : [])
  expect(await ctx.memory.search('a', { query: '설계', limit: 1 })).toHaveLength(1)
  expect(await ctx.memory.search('a', { query: '설계' })).toHaveLength(2)
})

test('동시 연결의 오래된 수정과 삭제 및 다른 프로젝트의 변경을 거부하고 최신 변경만 남긴다', async (t) => {
  const { ctx, open } = await setup(t)
  const other = (await open()).ctx
  const saved = await ctx.memory.create('a', decision)
  const replacement = {
    title: '변경된 결정',
    content: 'Postgres로 변경한다',
    sources: [{ uri: 'file:///repo/ADR-8.md' }]
  }
  const updated = await other.memory.update('a', saved.id, saved.revision, replacement)
  expect(updated).toMatchObject({
    ...replacement,
    id: saved.id,
    projectId: 'a',
    revision: 2,
    createdAt: saved.createdAt
  })
  await expect(ctx.memory.update('a', saved.id, saved.revision, decision)).rejects.toThrow('revision conflict')
  await expect(ctx.memory.delete('a', saved.id, saved.revision)).rejects.toThrow('revision conflict')
  await expect(ctx.memory.update('b', saved.id, updated.revision, decision)).rejects.toThrow()
  await expect(ctx.memory.delete('b', saved.id, updated.revision)).rejects.toThrow()
  expect(await ctx.memory.search('a', { query: 'SQLite' })).toEqual([])
  expect(await ctx.memory.search('a', { query: 'Postgres' })).toEqual([updated])
  await ctx.memory.delete('a', saved.id, updated.revision)
  expect(await other.memory.get('a', saved.id)).toBeUndefined()
  expect(await other.memory.search('a', { query: 'Postgres' })).toEqual([])
})

test('잘못된 도구 인자와 취소된 변경을 거부하고 도구 수정과 삭제에 revision을 적용한다', async (t) => {
  const { ctx } = await setup(t)
  const tools = createMemoryTools(ctx.memory, 'a')
  const context = { threadId: 'thread', runId: 'run', toolCallId: 'call', signal: new AbortController().signal }
  const execute = async (name: string, args: Record<string, unknown>, signal = context.signal) =>
    JSON.parse(await tools.find((tool) => tool.name === name)!.execute(args, { ...context, signal }))
  const saved = await execute('memory_save', decision)
  for (const [name, args] of [
    ['memory_search', { query: ' ' }],
    ['memory_search', { query: '설계', limit: 0 }],
    ['memory_search', { query: '설계', limit: 51 }],
    ['memory_search', { query: '설계', projectId: 'b' }],
    ['memory_save', { ...decision, sources: [] }],
    ['memory_delete', { id: saved.id, expectedRevision: 0 }],
    ['memory_update', { ...decision, id: saved.id }]
  ] as const)
    await expect(execute(name, args)).rejects.toThrow()
  const signal = AbortSignal.abort(new Error('cancelled'))
  await expect(execute('memory_save', decision, signal)).rejects.toThrow('cancelled')
  await expect(ctx.memory.delete('a', saved.id, 1, { signal })).rejects.toThrow('cancelled')
  expect(await ctx.memory.search('a', { query: '설계' })).toHaveLength(1)
  const updated = await execute('memory_update', {
    ...decision,
    content: '수정한 내용',
    id: saved.id,
    expectedRevision: 1
  })
  expect(updated.content).toBe('수정한 내용')
  expect(updated.revision).toBe(2)
  expect(await execute('memory_get', { id: saved.id })).toEqual(updated)
  expect(await execute('memory_delete', { id: saved.id, expectedRevision: 2 })).toEqual({ deleted: true })
  expect(await execute('memory_get', { id: saved.id })).toBeNull()
})

test('공개 도구와 scopedMemory가 두 SQLite 연결에서 같은 프로젝트 행과 revision을 공유한다', async (t) => {
  const { ctx, open, path } = await setup(t)
  const other = (await open()).ctx
  const context = { threadId: 'first', runId: 'save', toolCallId: 'call', signal: new AbortController().signal }
  const saved = JSON.parse(
    await createMemoryTools(ctx.memory, 'project')
      .find((tool) => tool.name === 'memory_save')!
      .execute(decision, context)
  )
  const scoped = (await other.scopedMemory.list())[0]
  const { projectId, ...record } = saved
  expect(scoped).toEqual({ ...record, scope: { type: 'project', id: projectId } })
  expect(await other.scopedMemory.search({ text: 'SQLite', projectId: 'project' })).toEqual([scoped])
  const updated = await other.scopedMemory.save(
    { ...decision, content: 'Postgres로 변경', scope: scoped.scope },
    saved.id,
    1
  )
  expect(await ctx.memory.get('project', saved.id)).toMatchObject({ content: updated.content, revision: 2 })
  await expect(ctx.memory.update('project', saved.id, 1, decision)).rejects.toThrow(/revision conflict/)
  await expect(ctx.memory.delete('project', saved.id, 1)).rejects.toThrow(/revision conflict/)
  const latest = await ctx.memory.update('project', saved.id, 2, decision)
  await expect(other.scopedMemory.save({ ...decision, scope: scoped.scope }, saved.id, 2)).rejects.toThrow(
    /revision conflict/
  )
  await expect(other.scopedMemory.delete(saved.id, 2)).rejects.toThrow(/revision conflict/)
  expect((await other.scopedMemory.list())[0].revision).toBe(3)
  // The scoped reader takes its snapshot before the other connection commits the update.
  const competing = await Promise.allSettled([
    other.scopedMemory.save({ ...decision, content: '오래된 변경', scope: scoped.scope }, saved.id, latest.revision),
    ctx.memory.update('project', saved.id, latest.revision, { ...decision, content: '최신 변경' })
  ])
  expect(competing[0].status).toBe('rejected')
  expect(competing[1].status).toBe('fulfilled')
  expect(await ctx.memory.get('project', saved.id)).toMatchObject({ content: '최신 변경', revision: 4 })
  const database = new DatabaseSync(path)
  try {
    expect(database.prepare('SELECT count(*) AS count FROM project_memories').get()?.count).toBe(1)
    expect(database.prepare('SELECT count(*) AS count FROM memories').get()?.count).toBe(0)
    expect(database.prepare('SELECT revision FROM project_memories WHERE id = ?').get(saved.id)?.revision).toBe(4)
  } finally {
    database.close()
  }
  await other.scopedMemory.delete(saved.id, 4)
  expect(await ctx.memory.get('project', saved.id)).toBeUndefined()
  const uiCreated = await other.scopedMemory.save({ ...decision, scope: scoped.scope })
  expect(await ctx.memory.get('project', uiCreated.id)).toMatchObject({ title: decision.title, revision: 1 })
  await ctx.memory.delete('project', uiCreated.id, 1)
  expect(await other.scopedMemory.list()).toEqual([])
})

test('scopedMemory의 scope 변경과 재개방은 단일 행과 revision과 출처를 보존한다', async (t) => {
  const { ctx, fiber, open, path } = await setup(t)
  const entry = await ctx.scopedMemory.save({ ...decision, scope: { type: 'user' } })
  const conversation = await ctx.scopedMemory.save(
    { ...decision, scope: { type: 'conversation', id: 'thread' } },
    entry.id,
    1
  )
  expect(conversation.createdAt).toBe(entry.createdAt)
  const project = await ctx.scopedMemory.save({ ...decision, scope: { type: 'project', id: 'project' } }, entry.id, 2)
  expect(await ctx.memory.get('project', entry.id)).toMatchObject({ revision: 3 })
  await fiber.dispose()
  const reopened = await open()
  expect(await reopened.ctx.scopedMemory.list()).toEqual([project])
  const moved = await reopened.ctx.scopedMemory.save(
    { ...decision, scope: { type: 'project', id: 'other' } },
    entry.id,
    3
  )
  expect(await reopened.ctx.memory.get('project', entry.id)).toBeUndefined()
  expect(await reopened.ctx.memory.get('other', entry.id)).toMatchObject({ revision: 4 })
  await reopened.ctx.scopedMemory.save({ ...decision, scope: { type: 'user' } }, entry.id, moved.revision)
  expect(await reopened.ctx.memory.get('other', entry.id)).toBeUndefined()
  const database = new DatabaseSync(path)
  try {
    expect(database.prepare('SELECT count(*) AS count FROM memories').get()?.count).toBe(1)
    expect(database.prepare('SELECT count(*) AS count FROM project_memories').get()?.count).toBe(0)
    expect(database.prepare('SELECT count(*) AS count FROM threads').get()?.count).toBe(0)
  } finally {
    database.close()
  }
  const options = { signal: AbortSignal.abort() }
  await expect(reopened.ctx.scopedMemory.list(options)).rejects.toThrow()
  await expect(
    reopened.ctx.scopedMemory.save({ ...decision, scope: { type: 'user' } }, undefined, undefined, options)
  ).rejects.toThrow()
  await expect(reopened.ctx.scopedMemory.delete(entry.id, 5, options)).rejects.toThrow()
  await reopened.ctx.scopedMemory.delete(entry.id, 5)
  expect(await reopened.ctx.scopedMemory.list()).toEqual([])
  await expect(reopened.ctx.scopedMemory.save({ ...decision, scope: { type: 'user' } }, entry.id, 5)).rejects.toThrow(
    /does not exist/
  )
})

test('기존 project_memories의 긴 제목과 본문과 출처와 프로젝트 ID 및 임의 ID를 그대로 읽는다', async (t) => {
  const { ctx, path } = await setup(t)
  const projectId = 'p'.repeat(500)
  const content = {
    title: 't'.repeat(1000),
    content: 'c'.repeat(10000),
    sources: [{ uri: 'custom:source', label: 's'.repeat(1000) }]
  }
  const database = new DatabaseSync(path)
  try {
    database
      .prepare(`INSERT INTO project_memories (id, project_id, title, content, sources, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('existing-id', projectId, content.title, content.content, JSON.stringify(content.sources), 7, 123, 456)
  } finally {
    database.close()
  }
  expect(await ctx.scopedMemory.list()).toEqual([
    {
      ...content,
      id: 'existing-id',
      scope: { type: 'project', id: projectId },
      revision: 7,
      createdAt: 123,
      updatedAt: 456
    }
  ])
  const updated = await ctx.scopedMemory.save(
    { ...content, scope: { type: 'project', id: projectId } },
    'existing-id',
    7
  )
  expect(updated.revision).toBe(8)
  expect(updated.createdAt).toBe(123)
  expect(await ctx.memory.get(projectId, 'existing-id')).toMatchObject({ revision: 8, ...content })
})
