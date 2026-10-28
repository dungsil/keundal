import type { ExecutionOptions } from '@keundal/core'
import {
  parseMemoryDraft,
  parseMemoryEntry,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryScope,
  type MemorySearchQuery
} from '@keundal/memory'
import memoryPlugin, { type MemoryAdapter } from '@keundal/plugin-memory'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const draft = (scope: MemoryScope = { type: 'user' }, content = '한국어 TypeScript 선호'): MemoryDraft => ({
  scope,
  title: '사용자 선호',
  content,
  sources: [{ uri: 'keundal://threads/origin', label: '사용자 요청' }]
})

async function setup(t: TestContext) {
  const entries = new Map<string, MemoryEntry>()
  const adapter: MemoryAdapter = {
    list: async () => [...entries.values()],
    save: async (entry, options) => {
      if (entries.has(entry.id) !== options.update) throw new Error('missing or duplicate entry')
      if (options.update && entries.get(entry.id)?.revision !== options.expectedRevision)
        throw new Error('revision conflict')
      entries.set(entry.id, entry)
    },
    delete: async (id, expectedRevision) => {
      if (entries.get(id)?.revision !== expectedRevision) throw new Error('revision conflict')
      entries.delete(id)
    }
  }
  const ctx = new Context()
  const fiber = await ctx.plugin(memoryPlugin, { adapter })
  t.onTestFinished(() => fiber.dispose())
  return { ctx, entries, adapter, fiber }
}

test('scope와 출처와 생성 시각을 보존하고 수정과 삭제에 최신 revision을 요구한다', async (t) => {
  const { ctx } = await setup(t)
  const created = await ctx.scopedMemory.save(draft({ type: 'project', id: 'project' }))
  expect(created.revision).toBe(1)
  expect(typeof created.createdAt).toBe('number')
  const updated = await ctx.scopedMemory.save(draft({ type: 'conversation', id: 'thread' }, '수정 내용'), created.id, 1)
  expect(updated.createdAt).toBe(created.createdAt)
  expect(updated.sources).toEqual(created.sources)
  expect(updated.scope).toEqual({ type: 'conversation', id: 'thread' })
  expect(updated.content).toBe('수정 내용')
  expect(updated.revision).toBe(2)
  await expect(ctx.scopedMemory.save(draft(), created.id)).rejects.toThrow()
  await expect(ctx.scopedMemory.save(draft(), created.id, 1)).rejects.toThrow(/revision conflict/)
  await expect(ctx.scopedMemory.delete(created.id, 1)).rejects.toThrow(/revision conflict/)
  await ctx.scopedMemory.delete(created.id, 2)
  await expect(ctx.scopedMemory.delete(created.id, 2)).rejects.toThrow()
  await expect(ctx.scopedMemory.save(draft(), created.id, 2)).rejects.toThrow(/does not exist/)
  expect(await ctx.scopedMemory.list()).toEqual([])
})

test('입력과 저장소 반환값의 가변 참조를 외부에 노출하지 않는다', async (t) => {
  const { ctx, entries } = await setup(t)
  const input = draft({ type: 'project', id: 'project' })
  const created = await ctx.scopedMemory.save(input)
  input.content = '입력 변경'
  input.sources[0].label = '입력 출처 변경'
  created.sources[0].label = '반환 출처 변경'
  created.scope = { type: 'user' }
  const listed = await ctx.scopedMemory.list()
  listed[0].sources[0].label = '목록 변경'
  expect(entries.get(created.id)?.sources[0].label).toBe('사용자 요청')
  expect((await ctx.scopedMemory.list())[0].scope).toEqual({ type: 'project', id: 'project' })
  const searched = await ctx.scopedMemory.search({ text: '한국어', projectId: 'project' })
  searched[0].content = '검색 변경'
  expect((await ctx.scopedMemory.list())[0].content).toBe('한국어 TypeScript 선호')
})

test('Unicode 키워드를 정규화하고 정확히 선택한 scope에서만 검색한다', async (t) => {
  const { ctx } = await setup(t)
  const scopes: MemoryScope[] = [
    { type: 'user' },
    { type: 'project', id: 'project' },
    { type: 'project', id: 'other' },
    { type: 'conversation', id: 'thread' },
    { type: 'conversation', id: 'other' }
  ]
  const saved = await Promise.all(scopes.map((scope) => ctx.scopedMemory.save(draft(scope))))
  expect((await ctx.scopedMemory.search({ text: '한국어' })).map((entry) => entry.id)).toEqual([saved[0].id])
  const query = { text: '한국어'.normalize('NFD'), projectId: 'project', threadId: 'thread' }
  const results = await ctx.scopedMemory.search(query)
  expect(results.map((entry) => entry.id).sort()).toEqual([saved[0].id, saved[1].id, saved[3].id].sort())
  expect(await ctx.scopedMemory.search(query)).toEqual(results)
  expect(await ctx.scopedMemory.search({ text: '무관한단어', projectId: 'project', threadId: 'thread' })).toEqual([])
  expect(await ctx.scopedMemory.search({ text: '!!!' })).toEqual([])
  expect((await ctx.scopedMemory.search({ text: 'TYPESCRIPT', limit: 1 })).length).toBe(1)
})

test('한국어 조사가 붙은 단어를 찾고 무관한 영문 단어의 부분 문자열은 제외한다', async (t) => {
  const { ctx } = await setup(t)
  const entry = await ctx.scopedMemory.save(
    draft({ type: 'user' }, '한국어로 대답하고 dedicated database와 Nuxt를 사용한다')
  )
  expect((await ctx.scopedMemory.search({ text: '한국어' })).map(({ id }) => id)).toEqual([entry.id])
  expect((await ctx.scopedMemory.search({ text: 'Nuxt' })).map(({ id }) => id)).toEqual([entry.id])
  expect(await ctx.scopedMemory.search({ text: 'cat' })).toEqual([])
})

test('점수와 갱신 시각과 ID로 순서를 결정하고 기본 검색 한도를 지킨다', async (t) => {
  const { ctx, entries } = await setup(t)
  const saved = await Promise.all(Array.from({ length: 25 }, () => ctx.scopedMemory.save(draft())))
  for (const entry of entries.values()) entry.updatedAt = 1
  const expected = saved
    .map((entry) => entry.id)
    .sort()
    .slice(0, 20)
  expect((await ctx.scopedMemory.search({ text: '한국어' })).map((entry) => entry.id)).toEqual(expected)
  const highest = await ctx.scopedMemory.save(draft({ type: 'user' }, '한국어 TypeScript 추가 키워드'))
  expect((await ctx.scopedMemory.search({ text: '한국어 추가', limit: 1 }))[0].id).toBe(highest.id)
})

test('잘못된 payload와 revision과 limit을 거부하며 기존 프로젝트의 긴 문자열은 허용한다', async (t) => {
  const { ctx } = await setup(t)
  for (const value of [
    null,
    [],
    {},
    { ...draft(), id: crypto.randomUUID() },
    { ...draft(), title: '' },
    { ...draft(), content: '' },
    { ...draft(), sources: [] },
    { ...draft(), sources: [{ uri: '' }] },
    { ...draft(), scope: { type: 'user', id: 'extra' } },
    { ...draft(), scope: { type: 'project', id: '' } },
    { ...draft(), scope: { type: 'unknown' } }
  ]) {
    expect(() => parseMemoryDraft(value)).toThrow()
    await expect(ctx.scopedMemory.save(value as MemoryDraft)).rejects.toThrow()
  }
  for (const limit of [0, -1, 21, 1.5, NaN, '2', null])
    await expect(ctx.scopedMemory.search({ text: '한국어', limit } as MemorySearchQuery)).rejects.toThrow()
  await expect(ctx.scopedMemory.search({ text: 'ok', projectId: '' })).rejects.toThrow()
  await expect(ctx.scopedMemory.search({ text: 'ok', extra: true } as MemorySearchQuery)).rejects.toThrow()
  await expect(ctx.scopedMemory.delete('', 1)).rejects.toThrow()
  const entry = await ctx.scopedMemory.save(draft())
  for (const revision of [0, -1, 1.5, NaN, undefined])
    await expect(ctx.scopedMemory.save(draft(), entry.id, revision)).rejects.toThrow()
  expect(() => parseMemoryEntry({ ...entry, createdAt: new Date().toISOString() })).toThrow()
  const long = draft({ type: 'project', id: 'x'.repeat(500) }, 'x'.repeat(10000))
  long.title = 't'.repeat(1000)
  long.sources[0].label = 's'.repeat(1000)
  const saved = await ctx.scopedMemory.save(long)
  expect(await ctx.memory.get('x'.repeat(500), saved.id)).toMatchObject({ title: long.title, content: long.content })
})

test('이미 취소된 호출과 해제된 서비스는 저장소 접근을 거부한다', async (t) => {
  const { ctx, adapter, fiber } = await setup(t)
  const entry = await ctx.scopedMemory.save(draft())
  const options = { signal: AbortSignal.abort(new Error('cancelled')) }
  adapter.list =
    adapter.save =
    adapter.delete =
      async () => {
        throw new Error('unexpected IO')
      }
  await expect(ctx.scopedMemory.list(options)).rejects.toThrow('cancelled')
  await expect(ctx.scopedMemory.save(draft(), undefined, undefined, options)).rejects.toThrow('cancelled')
  await expect(ctx.scopedMemory.delete(entry.id, 1, options)).rejects.toThrow('cancelled')
  await expect(ctx.scopedMemory.search({ text: '한국어' }, options)).rejects.toThrow('cancelled')
  const service = ctx.scopedMemory
  const project = ctx.memory
  await fiber.dispose()
  await expect(service.list()).rejects.toThrow(/disposed/)
  await expect(project.get('p', entry.id)).rejects.toThrow(/disposed/)
})

test('진행 중인 저장소 IO에 취소 신호를 전달한다', async (t) => {
  const { ctx, adapter } = await setup(t)
  const started = Promise.withResolvers<void>()
  const controller = new AbortController()
  let forwarded: ExecutionOptions | undefined
  adapter.list = async (options) =>
    new Promise((_resolve, reject) => {
      forwarded = options
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      started.resolve()
    })
  const pending = ctx.scopedMemory.search({ text: '한국어' }, { signal: controller.signal })
  await started.promise
  expect(forwarded?.signal).toBe(controller.signal)
  controller.abort(new Error('cancelled IO'))
  await expect(pending).rejects.toThrow('cancelled IO')
})

test('목록 조회 이후 삭제되거나 수정된 항목의 동시 쓰기를 원자적으로 거부한다', async (t) => {
  const { ctx, adapter, entries } = await setup(t)
  const entry = await ctx.scopedMemory.save(draft())
  const list = adapter.list
  adapter.list = async (options) => {
    const snapshot = (await list(options)).map(parseMemoryEntry)
    entries.set(entry.id, { ...entry, revision: 2, content: '다른 연결 수정' })
    return snapshot
  }
  await expect(ctx.scopedMemory.save(draft(), entry.id, 1)).rejects.toThrow(/revision conflict/)
  expect(entries.get(entry.id)?.content).toBe('다른 연결 수정')
  adapter.list = async (options) => {
    const snapshot = await list(options)
    entries.delete(entry.id)
    return snapshot
  }
  await expect(ctx.scopedMemory.save(draft(), entry.id, 2)).rejects.toThrow(/missing/)
  expect(entries.size).toBe(0)
})
