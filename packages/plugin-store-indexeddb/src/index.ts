import type { Context } from 'cordis'

import { IndexedDBBackupService } from './backup.js'
import { indexedDBStoreConfigSchema, type IndexedDBStoreConfig } from './config.js'
import { IndexedDBGenerationService } from './generation.js'
import { IndexedDBSessionService } from './session.js'
import { IndexedDBStore } from './store.js'
import { IndexedDBTaskStore } from './tasks.js'

export const metadata = {
  name: { en: 'Browser storage', ko: '브라우저 저장소' },
  description: {
    en: 'Saves conversations and runs in this browser using IndexedDB.',
    ko: 'IndexedDB를 사용해 이 브라우저에 대화와 실행 기록을 저장합니다.'
  }
}

export { IndexedDBBackupService } from './backup.js'
export { indexedDBStoreConfigSchema, type IndexedDBStoreConfig } from './config.js'
export { IndexedDBGenerationService } from './generation.js'
export { IndexedDBSessionService } from './session.js'
export { IndexedDBStore, type IndexedDBStoreOptions, type WebLockManager } from './store.js'
export { IndexedDBTaskStore } from './tasks.js'

/** session과 generation을 같은 IndexedDB 데이터베이스로 제공합니다. */
export const indexedDBStorePlugin = Object.assign(
  function indexedDBStorePlugin(ctx: Context, config: IndexedDBStoreConfig = {}) {
    const store = config.store ?? new IndexedDBStore(config)
    new IndexedDBSessionService(ctx, store)
    new IndexedDBBackupService(ctx, store)
    new IndexedDBTaskStore(ctx, store)
    const generation = ctx.inject(['llm', 'session'], (injected) => {
      new IndexedDBGenerationService(injected, store)
    })
    ctx.effect(() => async () => {
      await generation.dispose()
      if (config.store === undefined) store.close()
    })
  },
  { Config: indexedDBStoreConfigSchema }
)

export default indexedDBStorePlugin
