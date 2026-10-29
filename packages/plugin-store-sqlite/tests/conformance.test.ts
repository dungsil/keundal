import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { LLMService, type LLMEvent, type LLMModel } from '@keundal/llm'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import {
  checkConcurrentCommitProperties,
  expectedConformanceReport,
  runStoreConformance,
  type ConformanceStore
} from '@keundal/store-conformance'
import { Context, type Fiber } from 'cordis'
import { assert, expect, test } from 'vitest'

test('저장소 적합성과 동시 커밋의 단일 반영 및 journal 재생을 검증한다', async () => {
  const makeStore = async (): Promise<ConformanceStore> => {
    const path = join(mkdtempSync(join(tmpdir(), 'conformance-')), 'db.sqlite')
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
    fibers.push(await ctx.plugin(sqliteStorePlugin, { path }))
    return {
      session: ctx.session,
      generation: ctx.generation,
      backup: ctx.backup,
      disposeAll: async () => {
        try {
          for (const fiber of fibers.toReversed()) await fiber.dispose()
        } finally {
          rmSync(dirname(path), { recursive: true, force: true })
        }
      }
    }
  }

  await checkConcurrentCommitProperties(makeStore, assert)
  const report = await runStoreConformance(makeStore)
  expect(report).toEqual(expectedConformanceReport)
  const store = await makeStore()
  const session = store.session as import('@keundal/session').SessionService
  try {
    await session.delete('thread', 0)
    await expect(session.delete(' ', 0)).rejects.toThrow('non-empty')
    await expect(session.delete('thread', -1)).rejects.toThrow('non-negative')
    const commit = (expectedRevision: number, id?: string, mode?: 'replace') =>
      session.commit({
        threadId: 'thread',
        expectedRevision,
        mode,
        messages: id ? [{ id, role: 'user', content: id }] : [],
        state: undefined
      })
    await commit(0, 'old')
    await commit(1, 'new')
    expect((await session.get('thread'))?.messages.map((m) => m.id)).toEqual(['old', 'new'])
    await expect(commit(1, undefined, 'replace')).rejects.toThrow('revision conflict')
    await commit(2, 'only', 'replace')
    expect((await session.get('thread'))?.messages.map((m) => m.id)).toEqual(['only'])
    await commit(3, undefined, 'replace')
    expect((await session.get('thread'))?.messages).toEqual([])
    await expect(session.delete('thread', 3)).rejects.toThrow('revision conflict')
    const release = Promise.withResolvers<void>()
    const iterator = store.generation
      .run(
        {
          input: { threadId: 'thread', runId: 'editing', messages: [], state: undefined, tools: [], context: [] },
          model: 'test',
          maxOutputTokens: 20,
          sessionRevision: 4
        },
        {
          stream: async function* () {
            await release.promise
            yield* []
          }
        }
      )
      [Symbol.asyncIterator]()
    try {
      await iterator.next()
      await expect(session.delete('thread', 4)).rejects.toThrow('running generation')
      expect((await store.generation.get('editing'))?.status).toBe('running')
    } finally {
      release.resolve()
      while (!(await iterator.next()).done) {
        /* drain */
      }
    }
    expect((await store.generation.get('editing'))?.journal.length).toBeGreaterThan(0)
    const terminal = await store.generation.get('editing')
    await session.commit({
      threadId: 'thread',
      expectedRevision: 0,
      mode: 'replace',
      messages: [{ id: 'duplicate', role: 'user', content: 'ignored' }],
      state: undefined,
      generation: terminal as import('@keundal/generation').TerminalGeneration
    })
    expect((await session.get('thread'))?.messages).toEqual([])
    await session.delete('thread', 5)
    expect(await session.get('thread')).toBeUndefined()
    expect(await store.generation.get('editing')).toBeUndefined()
    expect(await store.generation.list()).toEqual([])
    await session.delete('thread', 0)
  } finally {
    await store.disposeAll()
  }
})
