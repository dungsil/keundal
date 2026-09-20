import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LLMService, type LLMEvent, type LLMModel } from '@keundal/core'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { expectedConformanceReport, runStoreConformance, type ConformanceStore } from '@keundal/store-conformance'
import { Context, type Fiber } from 'cordis'
import { expect, test } from 'vitest'

test('저장소 적합성 시나리오를 통과한다', async () => {
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
      disposeAll: async () => {
        for (const fiber of fibers.toReversed()) await fiber.dispose()
      }
    }
  }

  const report = await runStoreConformance(makeStore)
  expect(report).toEqual(expectedConformanceReport)
})
