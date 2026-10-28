import type { ExecutionOptions } from '@keundal/core'
import {
  parseMemoryDraft,
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
  content,
  source: { label: '사용자 요청', threadId: 'origin', messageId: 'message' }
})

async function setup(t: TestContext) {
  const entries = new Map<string, MemoryEntry>()
  const adapter: MemoryAdapter = {
    list: async () => [...entries.values()],
    save: async (entry, options) => {
      if (entries.has(entry.id) !== options.update) throw new Error('missing or duplicate entry')
      entries.set(entry.id, entry)
    },
    delete: async (id) => {
      entries.delete(id)
    }
  }
  const ctx = new Context()
  const fiber = await ctx.plugin(memoryPlugin, { adapter })
  t.onTestFinished(() => fiber.dispose())
  return { ctx, entries, adapter, fiber }
}

test('scope와 출처를 보존하고 생성 시각을 유지하며 기존 항목만 수정한다', async (t) => {
  const { ctx } = await setup(t)
  const created = await ctx.memory.save(draft({ type: 'project', id: 'project' }))
  expect(created.id).toMatch(/^[\da-f-]{36}$/)
  const updated = await ctx.memory.save(
    { ...draft({ type: 'conversation', id: 'thread' }, '수정 내용'), source: created.source },
    created.id
  )
  expect(updated.createdAt).toBe(created.createdAt)
  expect(updated.source).toEqual(created.source)
  expect(updated.scope).toEqual({ type: 'conversation', id: 'thread' })
  expect(updated.content).toBe('수정 내용')
  await ctx.memory.delete(created.id)
  await ctx.memory.delete(created.id)
  await expect(ctx.memory.save(draft(), created.id)).rejects.toThrow(/does not exist/)
  expect(await ctx.memory.list()).toEqual([])
})

test('입력과 저장소 반환값의 가변 참조를 외부에 노출하지 않는다', async (t) => {
  const { ctx, entries } = await setup(t)
  const input = draft({ type: 'project', id: 'project' })
  const created = await ctx.memory.save(input)
  input.content = '입력 변경'
  input.source.label = '입력 출처 변경'
  created.source.label = '반환 출처 변경'
  created.scope = { type: 'user' }
  const listed = await ctx.memory.list()
  listed[0].source.label = '목록 변경'
  expect(entries.get(created.id)?.source.label).toBe('사용자 요청')
  expect((await ctx.memory.list())[0].scope).toEqual({ type: 'project', id: 'project' })
  const searched = await ctx.memory.search({ text: '한국어', projectId: 'project' })
  searched[0].content = '검색 변경'
  expect((await ctx.memory.list())[0].content).toBe('한국어 TypeScript 선호')
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
  const saved = await Promise.all(scopes.map((scope) => ctx.memory.save(draft(scope))))
  expect((await ctx.memory.search({ text: '한국어' })).map((entry) => entry.id)).toEqual([saved[0].id])
  const query = { text: '한국어'.normalize('NFD'), projectId: 'project', threadId: 'thread' }
  const results = await ctx.memory.search(query)
  expect(results.map((entry) => entry.id).sort()).toEqual([saved[0].id, saved[1].id, saved[3].id].sort())
  expect(await ctx.memory.search(query)).toEqual(results)
  expect(await ctx.memory.search({ text: '무관한단어', projectId: 'project', threadId: 'thread' })).toEqual([])
  expect(await ctx.memory.search({ text: '!!!' })).toEqual([])
  expect((await ctx.memory.search({ text: 'TYPESCRIPT', limit: 1 })).length).toBe(1)
})

test('한국어 조사가 붙은 단어를 찾고 무관한 영문 단어의 부분 문자열은 제외한다', async (t) => {
  const { ctx } = await setup(t)
  const entry = await ctx.memory.save(draft({ type: 'user' }, '한국어로 대답하고 dedicated database와 Nuxt를 사용한다'))
  expect((await ctx.memory.search({ text: '한국어' })).map(({ id }) => id)).toEqual([entry.id])
  expect((await ctx.memory.search({ text: 'Nuxt' })).map(({ id }) => id)).toEqual([entry.id])
  expect(await ctx.memory.search({ text: 'cat' })).toEqual([])
})

test('점수와 갱신 시각과 ID로 순서를 결정하고 기본 검색 한도를 지킨다', async (t) => {
  const { ctx, entries } = await setup(t)
  const saved = await Promise.all(Array.from({ length: 25 }, () => ctx.memory.save(draft())))
  for (const entry of entries.values()) entry.updatedAt = '2026-01-01T00:00:00.000Z'
  const expected = saved
    .map((entry) => entry.id)
    .sort()
    .slice(0, 20)
  expect((await ctx.memory.search({ text: '한국어' })).map((entry) => entry.id)).toEqual(expected)
  const highest = await ctx.memory.save(draft({ type: 'user' }, '한국어 TypeScript 추가 키워드'))
  expect((await ctx.memory.search({ text: '한국어 추가', limit: 1 }))[0].id).toBe(highest.id)
})

test('잘못된 payload와 범위를 벗어난 문자열과 limit을 거부한다', async (t) => {
  const { ctx } = await setup(t)
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...draft(), id: crypto.randomUUID() },
    { ...draft(), content: '' },
    { ...draft(), content: 'x'.repeat(4001) },
    { ...draft(), scope: { type: 'user', id: 'extra' } },
    { ...draft(), scope: { type: 'project', id: 'x'.repeat(201) } },
    { ...draft(), scope: { type: 'conversation', id: '' } },
    { ...draft(), scope: { type: 'unknown' } },
    { ...draft(), source: null },
    { ...draft(), source: { label: '' } },
    { ...draft(), source: { label: 'x'.repeat(201) } },
    { ...draft(), source: { label: 'ok', messageId: 1 } },
    { ...draft(), source: { label: 'ok', threadId: 'x'.repeat(201) } }
  ]
  for (const value of invalid) {
    expect(() => parseMemoryDraft(value)).toThrow(TypeError)
    await expect(ctx.memory.save(value as MemoryDraft)).rejects.toThrow(TypeError)
  }
  for (const limit of [0, -1, 21, 1.5, NaN, '2', null])
    await expect(ctx.memory.search({ text: '한국어', limit } as MemorySearchQuery)).rejects.toThrow(TypeError)
  await expect(ctx.memory.search({ text: 'ok', projectId: '' })).rejects.toThrow(TypeError)
  await expect(ctx.memory.search({ text: 'ok', extra: true } as MemorySearchQuery)).rejects.toThrow(TypeError)
  await expect(ctx.memory.delete('not-a-uuid')).rejects.toThrow(TypeError)
  await expect(ctx.memory.save(draft(), '')).rejects.toThrow(TypeError)
  expect(parseMemoryDraft(draft({ type: 'project', id: 'x'.repeat(200) }, 'x'.repeat(4000))).content).toHaveLength(4000)
})

test('이미 취소된 호출은 저장소에 접근하지 않고 해제된 서비스도 거부한다', async (t) => {
  const { ctx, adapter, fiber } = await setup(t)
  const entry = await ctx.memory.save(draft())
  const options = { signal: AbortSignal.abort(new Error('cancelled')) }
  adapter.list = async () => {
    throw new Error('unexpected IO')
  }
  adapter.save = async () => {
    throw new Error('unexpected IO')
  }
  adapter.delete = async () => {
    throw new Error('unexpected IO')
  }
  await expect(ctx.memory.list(options)).rejects.toThrow('cancelled')
  await expect(ctx.memory.save(draft(), undefined, options)).rejects.toThrow('cancelled')
  await expect(ctx.memory.delete(entry.id, options)).rejects.toThrow('cancelled')
  await expect(ctx.memory.search({ text: '한국어' }, options)).rejects.toThrow('cancelled')
  const service = ctx.memory
  await fiber.dispose()
  await expect(service.list()).rejects.toThrow(/disposed/)
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
  const pending = ctx.memory.search({ text: '한국어' }, { signal: controller.signal })
  await started.promise
  expect(forwarded?.signal).toBe(controller.signal)
  controller.abort(new Error('cancelled IO'))
  await expect(pending).rejects.toThrow('cancelled IO')
})

test('저장소에서 삭제된 항목의 동시 수정은 항목을 다시 만들지 않는다', async (t) => {
  const { ctx, adapter, entries } = await setup(t)
  const entry = await ctx.memory.save(draft())
  const list = adapter.list
  adapter.list = async (options) => {
    const snapshot = await list(options)
    entries.delete(entry.id)
    return snapshot
  }
  await expect(ctx.memory.save(draft(), entry.id)).rejects.toThrow(/missing/)
  expect(entries.size).toBe(0)
})
