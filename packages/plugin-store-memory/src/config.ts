import type { StandardSchemaV1 } from '@standard-schema/spec'

import { MemoryStore } from './store.js'

export interface MemoryStoreConfig {
  /** 재등록 사이에 저장 상태를 유지하려면 같은 인스턴스를 전달합니다. */
  readonly store?: MemoryStore
}

export const memoryStoreConfigSchema: StandardSchemaV1<MemoryStoreConfig, MemoryStoreConfig> = {
  '~standard': {
    version: 1,
    vendor: 'keundal',
    validate(value) {
      if (value === undefined) return { value: {} }
      if (typeof value !== 'object' || value === null)
        return { issues: [{ message: 'memory store configuration must be an object' }] }
      const store: unknown = Reflect.get(value, 'store')
      if (store === undefined) return { value: {} }
      if (!(store instanceof MemoryStore)) return { issues: [{ message: 'store must be a MemoryStore instance' }] }
      return { value: { store } }
    }
  }
}
