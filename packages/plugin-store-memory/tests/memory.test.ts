import { LLMService, type LLMEvent, type LLMModel, type LLMRequest } from '@keundal/llm'
import type { MemoryDraft } from '@keundal/memory'
import memoryStorePlugin, { MemoryStore } from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

const draft: MemoryDraft = {
  scope: { type: 'project', id: 'project' },
  title: '사용자 선호',
  content: '한국어 답변 선호',
  sources: [{ uri: 'keundal://threads/origin', label: '사용자 요청' }]
}

test('세션 상태와 별도로 기억을 저장하고 같은 저장소를 재등록해 유지한다', async (t) => {
  const store = new MemoryStore()
  const ctx = new Context()
  const first = await ctx.plugin(memoryStorePlugin, { store })
  t.onTestFinished(() => first.dispose())
  const entry = await ctx.scopedMemory.save(draft)
  expect(await ctx.session.list()).toEqual([])
  expect(store.threads.size).toBe(0)
  await first.dispose()
  const second = await ctx.plugin(memoryStorePlugin, { store })
  t.onTestFinished(() => second.dispose())
  expect(await ctx.scopedMemory.list()).toEqual([entry])
  const updated = await ctx.scopedMemory.save({ ...draft, content: '수정한 한국어 선호' }, entry.id, entry.revision)
  expect(updated.createdAt).toBe(entry.createdAt)
  expect(updated.sources).toEqual(entry.sources)
  const global = await ctx.scopedMemory.save({ ...draft, scope: { type: 'user' } })
  await ctx.scopedMemory.save({ ...draft, scope: { type: 'conversation', id: 'other' } })
  expect((await ctx.scopedMemory.search({ text: '한국어' })).map(({ id }) => id)).toEqual([global.id])
  await ctx.scopedMemory.delete(entry.id, updated.revision)
  await expect(ctx.scopedMemory.save(draft, entry.id, updated.revision)).rejects.toThrow(/does not exist/)
  const options = { signal: AbortSignal.abort() }
  await expect(ctx.scopedMemory.save(draft, undefined, undefined, options)).rejects.toThrow()
  await expect(ctx.scopedMemory.list(options)).rejects.toThrow()
  await expect(ctx.scopedMemory.delete(global.id, global.revision, options)).rejects.toThrow()
  expect((await ctx.scopedMemory.list()).some(({ id }) => id === global.id)).toBe(true)
})

test('LLM을 등록하거나 해제해도 기존 기억 서비스로 저장 내용을 계속 읽는다', async (t) => {
  class LLM extends LLMService {
    async getModel(): Promise<LLMModel> {
      throw new Error('unused')
    }
    async countTokens(): Promise<number> {
      throw new Error('unused')
    }
    stream(_request: LLMRequest): AsyncIterable<LLMEvent> {
      throw new Error('unused')
    }
  }
  const ctx = new Context()
  const store = await ctx.plugin(memoryStorePlugin)
  t.onTestFinished(() => store.dispose())
  const memory = ctx.scopedMemory
  const entry = await memory.save(draft)
  const llm = await ctx.plugin(LLM)
  t.onTestFinished(() => llm.dispose())
  expect(await memory.list()).toEqual([entry])
  expect(await ctx.scopedMemory.list()).toEqual([entry])
  await llm.dispose()
  expect(await ctx.scopedMemory.list()).toEqual([entry])
  expect(await memory.list()).toEqual([entry])
})

test('프로젝트 API와 scopedMemory가 같은 항목과 revision을 공유하고 오래된 변경을 거부한다', async (t) => {
  const store = new MemoryStore()
  const ctx = new Context()
  const other = new Context()
  const first = await ctx.plugin(memoryStorePlugin, { store })
  const second = await other.plugin(memoryStorePlugin, { store })
  t.onTestFinished(() => first.dispose())
  t.onTestFinished(() => second.dispose())
  const { scope: _scope, ...content } = draft
  const created = await ctx.memory.create('project', content)
  const scoped = (await other.scopedMemory.list())[0]
  expect(scoped).toEqual({
    ...content,
    id: created.id,
    scope: draft.scope,
    revision: 1,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt
  })
  const updated = await other.scopedMemory.save({ ...draft, content: 'SQLite 결정 90%' }, created.id, 1)
  expect(await ctx.memory.get('project', created.id)).toMatchObject({ content: updated.content, revision: 2 })
  expect(await ctx.memory.search('project', { query: '결정 90%' })).toHaveLength(1)
  await expect(ctx.memory.update('project', created.id, 1, content)).rejects.toThrow(/revision conflict/)
  await expect(ctx.memory.delete('project', created.id, 1)).rejects.toThrow(/revision conflict/)
  const third = await ctx.memory.update('project', created.id, 2, content)
  await expect(other.scopedMemory.save(draft, created.id, 2)).rejects.toThrow(/revision conflict/)
  await expect(other.scopedMemory.delete(created.id, 2)).rejects.toThrow(/revision conflict/)
  await other.scopedMemory.delete(created.id, third.revision)
  expect(await ctx.memory.get('project', created.id)).toBeUndefined()
  const uiCreated = await ctx.scopedMemory.save(draft)
  expect(await other.memory.get('project', uiCreated.id)).toMatchObject({ revision: 1, sources: draft.sources })
  await other.memory.delete('project', uiCreated.id, 1)
  expect(await ctx.scopedMemory.list()).toEqual([])
})
