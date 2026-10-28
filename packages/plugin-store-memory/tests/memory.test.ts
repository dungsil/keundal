import { LLMService, type LLMEvent, type LLMModel, type LLMRequest } from '@keundal/llm'
import type { MemoryDraft } from '@keundal/memory'
import memoryStorePlugin, { MemoryStore } from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

const draft: MemoryDraft = {
  scope: { type: 'project', id: 'project' },
  content: '한국어 답변 선호',
  source: { label: '사용자 요청', threadId: 'origin', messageId: 'message' }
}

test('세션 상태와 별도로 기억을 저장하고 같은 저장소를 재등록해 유지한다', async (t) => {
  const store = new MemoryStore()
  const ctx = new Context()
  const first = await ctx.plugin(memoryStorePlugin, { store })
  t.onTestFinished(() => first.dispose())
  const entry = await ctx.memory.save(draft)
  expect(await ctx.session.list()).toEqual([])
  expect(store.threads.size).toBe(0)
  await first.dispose()
  const second = await ctx.plugin(memoryStorePlugin, { store })
  t.onTestFinished(() => second.dispose())
  expect(await ctx.memory.list()).toEqual([entry])
  const updated = await ctx.memory.save({ ...draft, content: '수정한 한국어 선호' }, entry.id)
  expect(updated.createdAt).toBe(entry.createdAt)
  expect(updated.source).toEqual(entry.source)
  const global = await ctx.memory.save({ ...draft, scope: { type: 'user' } })
  await ctx.memory.save({ ...draft, scope: { type: 'conversation', id: 'other' } })
  expect((await ctx.memory.search({ text: '한국어' })).map(({ id }) => id)).toEqual([global.id])
  await ctx.memory.delete(entry.id)
  await expect(ctx.memory.save(draft, entry.id)).rejects.toThrow(/does not exist/)
  const options = { signal: AbortSignal.abort() }
  await expect(ctx.memory.save(draft, undefined, options)).rejects.toThrow()
  await expect(ctx.memory.list(options)).rejects.toThrow()
  await expect(ctx.memory.delete(global.id, options)).rejects.toThrow()
  expect((await ctx.memory.list()).some(({ id }) => id === global.id)).toBe(true)
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
  const memory = ctx.memory
  const entry = await memory.save(draft)
  const llm = await ctx.plugin(LLM)
  t.onTestFinished(() => llm.dispose())
  expect(await memory.list()).toEqual([entry])
  expect(await ctx.memory.list()).toEqual([entry])
  await llm.dispose()
  expect(await ctx.memory.list()).toEqual([entry])
  expect(await memory.list()).toEqual([entry])
})
