import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  return { open, ...(await open()) }
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
