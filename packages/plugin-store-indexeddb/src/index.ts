import type { Context } from 'cordis'

import { indexedDBStoreConfigSchema, type IndexedDBStoreConfig } from './config.js'
import { IndexedDBGenerationService } from './generation.js'
import { IndexedDBSessionService } from './session.js'
import { IndexedDBStore } from './store.js'

export { indexedDBStoreConfigSchema, type IndexedDBStoreConfig } from './config.js'
export { IndexedDBGenerationService } from './generation.js'
export { IndexedDBSessionService } from './session.js'
export { IndexedDBStore, type IndexedDBStoreOptions, type WebLockManager } from './store.js'

/** session과 generation을 같은 IndexedDB 데이터베이스로 제공합니다. */
export const indexedDBStorePlugin = Object.assign(
  function indexedDBStorePlugin(ctx: Context, config: IndexedDBStoreConfig = {}) {
    const store = config.store ?? new IndexedDBStore(config)
    new IndexedDBSessionService(ctx, store)
    new IndexedDBGenerationService(ctx, store, config.store === undefined)
  },
  { inject: ['llm'], Config: indexedDBStoreConfigSchema }
)

export default indexedDBStorePlugin
