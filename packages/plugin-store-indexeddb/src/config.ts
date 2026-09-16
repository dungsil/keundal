import type { StandardSchemaV1 } from '@standard-schema/spec'

import { IndexedDBStore, type IndexedDBStoreOptions } from './store.js'

export interface IndexedDBStoreConfig extends IndexedDBStoreOptions {
  /** 이미 연 저장소를 전달하면 플러그인을 해제해도 저장소를 닫지 않습니다. */
  readonly store?: IndexedDBStore
}

export const indexedDBStoreConfigSchema: StandardSchemaV1<IndexedDBStoreConfig, IndexedDBStoreConfig> = {
  '~standard': {
    version: 1,
    vendor: 'keundal',
    validate(value) {
      if (value === undefined) return { value: {} }
      if (typeof value !== 'object' || value === null)
        return { issues: [{ message: 'indexeddb store configuration must be an object' }] }
      const store: unknown = Reflect.get(value, 'store')
      const databaseName: unknown = Reflect.get(value, 'databaseName')
      const indexedDB: unknown = Reflect.get(value, 'indexedDB')
      const locks: unknown = Reflect.get(value, 'locks')
      if (store !== undefined && !(store instanceof IndexedDBStore))
        return { issues: [{ message: 'store must be an IndexedDBStore instance' }] }
      if (databaseName !== undefined && (typeof databaseName !== 'string' || !databaseName.trim()))
        return { issues: [{ message: 'databaseName must be a non-empty string' }] }
      if (indexedDB !== undefined && (typeof indexedDB !== 'object' || indexedDB === null))
        return { issues: [{ message: 'indexedDB must be an IDBFactory' }] }
      if (locks !== undefined && (typeof locks !== 'object' || locks === null))
        return { issues: [{ message: 'locks must be a Web Locks implementation' }] }
      return {
        value: {
          ...(store === undefined ? {} : { store: store as IndexedDBStore }),
          ...(databaseName === undefined ? {} : { databaseName }),
          ...(indexedDB === undefined ? {} : { indexedDB: indexedDB as IDBFactory }),
          ...(locks === undefined ? {} : { locks: locks as IndexedDBStoreOptions['locks'] })
        }
      }
    }
  }
}
