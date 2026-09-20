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
})
