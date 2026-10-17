import { LLMService, type LLMEvent, type LLMModel } from '@keundal/core'
import memoryStorePlugin, { MemoryStore } from '@keundal/plugin-store-memory'
import { expectedConformanceReport, runStoreConformance, type ConformanceStore } from '@keundal/store-conformance'
import { Context, type Fiber } from 'cordis'
import { expect, test } from 'vitest'

test('저장소 적합성 시나리오를 통과한다', async () => {
  const makeStore = async (): Promise<ConformanceStore> => {
    const ctx = new Context()
    class LLM extends LLMService {
      async getModel(): Promise<LLMModel> {
        throw new Error('conformance must not resolve model limits')
      }
      async countTokens(): Promise<number> {
        throw new Error('conformance must not count tokens')
      }
      stream(): AsyncIterableIterator<LLMEvent> {
        throw new Error('conformance must not call llm directly')
      }
    }
    const fibers: Fiber[] = [await ctx.plugin(LLM)]
    fibers.push(await ctx.plugin(memoryStorePlugin, { store: new MemoryStore() }))
    return {
      session: ctx.session,
      generation: ctx.generation,
      disposeAll: async () => {
        for (const fiber of fibers.toReversed()) await fiber.dispose()
      }
    }
  }

  const report = await runStoreConformance(makeStore)
  expect(report).toEqual(expectedConformanceReport)
  await checkSessionEditing(await makeStore())
})

async function checkSessionEditing(store: ConformanceStore): Promise<void> {
  const session = store.session as import('@keundal/core').SessionService
  const message = (id: string) => ({ id, role: 'user' as const, content: id })
  try {
    await session.delete('missing', 0)
    await session.delete('missing', 0)
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(session.delete('missing', revision)).rejects.toThrow('non-negative')
    await expect(session.delete(' ', 0)).rejects.toThrow('non-empty')
    await expect(session.delete('missing', 1)).rejects.toThrow('revision conflict')
    const aborted = AbortSignal.abort(new Error('cancelled delete'))
    await expect(session.delete('missing', 0, { signal: aborted })).rejects.toThrow('cancelled delete')
    await session.commit({ threadId: 'thread', expectedRevision: 0, messages: [message('old')], state: undefined })
    await session.commit({ threadId: 'thread', expectedRevision: 1, messages: [message('new')], state: undefined })
    expect((await session.get('thread'))?.messages.map((m) => m.id)).toEqual(['old', 'new'])
    await expect(
      session.commit({ threadId: 'thread', expectedRevision: 1, mode: 'replace', messages: [], state: undefined })
    ).rejects.toThrow('revision conflict')
    await session.commit({
      threadId: 'thread',
      expectedRevision: 2,
      mode: 'replace',
      messages: [message('only')],
      state: undefined
    })
    expect((await session.get('thread'))?.messages.map((m) => m.id)).toEqual(['only'])
    await session.commit({ threadId: 'thread', expectedRevision: 3, mode: 'replace', messages: [], state: undefined })
    expect((await session.get('thread'))?.messages).toEqual([])
    await expect(session.delete('thread', 3)).rejects.toThrow('revision conflict')
    const request = {
      input: { threadId: 'thread', runId: 'editing-run', messages: [], state: undefined, tools: [], context: [] },
      model: 'test',
      maxOutputTokens: 20,
      sessionRevision: 4
    }
    const release = Promise.withResolvers<void>()
    const iterator = store.generation
      .run(request, {
        stream: async function* () {
          await release.promise
          yield* []
        }
      })
      [Symbol.asyncIterator]()
    try {
      await iterator.next()
      await expect(session.delete('thread', 4)).rejects.toThrow('running generation')
      expect((await store.generation.get('editing-run'))?.status).toBe('running')
    } finally {
      release.resolve()
      while (!(await iterator.next()).done) {
        /* drain */
      }
    }
    const terminal = await store.generation.get('editing-run')
    expect(terminal?.status).toBe('completed')
    expect(terminal?.journal.length).toBeGreaterThan(0)
    await session.commit({
      threadId: 'thread',
      expectedRevision: 0,
      mode: 'replace',
      messages: [message('duplicate')],
      state: undefined,
      generation: terminal as import('@keundal/core').TerminalGeneration
    })
    expect((await session.get('thread'))?.messages).toEqual([])
    await session.commit({ threadId: 'other', expectedRevision: 0, messages: [message('keep')], state: undefined })
    await session.delete('thread', 5)
    expect(await session.get('thread')).toBeUndefined()
    expect(await store.generation.get('editing-run')).toBeUndefined()
    expect(await store.generation.list()).toEqual([])
    expect((await session.list()).map((s) => s.threadId)).toEqual(['other'])
    await session.delete('thread', 0)
  } finally {
    await store.disposeAll()
  }
}
