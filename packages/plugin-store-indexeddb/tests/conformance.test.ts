import { LLMService, type LLMEvent, type LLMModel } from '@keundal/core'
import indexedDBStorePlugin, { IndexedDBStore, type WebLockManager } from '@keundal/plugin-store-indexeddb'
import { expectedConformanceReport, runStoreConformance, type ConformanceStore } from '@keundal/store-conformance'
import { Context, type Fiber } from 'cordis'
import { IDBFactory } from 'fake-indexeddb'
import { expect, test } from 'vitest'

class Locks implements WebLockManager {
  private readonly states = new Map<string, { locked: boolean; waiters: (() => void)[] }>()

  async request<T>(
    name: string,
    options: { readonly ifAvailable?: boolean; readonly signal?: AbortSignal },
    callback: (lock: unknown | null) => T | Promise<T>
  ): Promise<T> {
    options.signal?.throwIfAborted()
    const state = this.states.get(name) ?? { locked: false, waiters: [] }
    this.states.set(name, state)
    if (options.ifAvailable && state.locked) return callback(null)
    if (state.locked) await new Promise<void>((resolve) => state.waiters.push(resolve))
    options.signal?.throwIfAborted()
    state.locked = true
    try {
      return await callback({})
    } finally {
      state.locked = false
      state.waiters.shift()?.()
    }
  }
}

test('저장소 적합성 시나리오를 통과한다', async () => {
  const factory = new IDBFactory()
  const locks = new Locks()
  const makeStore = async (): Promise<ConformanceStore> => {
    const store = new IndexedDBStore({
      databaseName: `conformance-${globalThis.crypto.randomUUID()}`,
      indexedDB: factory,
      locks
    })
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
    fibers.push(await ctx.plugin(indexedDBStorePlugin, { store }))
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
