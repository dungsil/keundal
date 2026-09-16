import type { Context } from 'cordis'

import { memoryStoreConfigSchema, type MemoryStoreConfig } from './config.js'
import { MemoryGenerationService } from './generation.js'
import { MemorySessionService } from './session.js'
import { MemoryStore } from './store.js'

export { memoryStoreConfigSchema, type MemoryStoreConfig } from './config.js'
export { MemoryGenerationService } from './generation.js'
export { MemorySessionService } from './session.js'
export { MemoryStore, type StoredRun, type StoredThread } from './store.js'

/**
 * session과 generation 서비스를 메모리 저장소로 함께 제공합니다. 두 서비스가 같은 저장소를
 * 공유하므로 실행 종료 기록과 세션 커밋이 하나의 단위로 확정됩니다. config로 기존 저장소를
 * 전달하면 서비스 재등록 뒤에도 저장 상태가 유지되며, 전달하지 않으면 등록할 때마다 새 저장소를
 * 만듭니다.
 */
export const memoryStorePlugin = Object.assign(
  function memoryStorePlugin(ctx: Context, config: MemoryStoreConfig = {}) {
    const store = config.store ?? new MemoryStore()
    new MemorySessionService(ctx, store)
    new MemoryGenerationService(ctx, store)
  },
  { inject: ['llm'], Config: memoryStoreConfigSchema }
)

export default memoryStorePlugin
