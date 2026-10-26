import type { Context } from 'cordis'

import { sqliteStoreConfigSchema, type SqliteStoreConfig } from './config.js'
import { SqliteGenerationService } from './generation.js'
import { SqliteSessionService } from './session.js'
import { SqliteStore } from './store.js'

export const metadata = {
  name: { en: 'SQLite storage', ko: 'SQLite 저장소' },
  description: {
    en: 'Saves conversations and runs in a local SQLite database.',
    ko: '로컬 SQLite 데이터베이스에 대화와 실행 기록을 저장합니다.'
  }
}

export { sqliteStoreConfigSchema, type SqliteStoreConfig } from './config.js'
export { SqliteGenerationService } from './generation.js'
export { SqliteSessionService } from './session.js'
export { SqliteStore, type RunOwnership, type StoredRun, type StoredThread } from './store.js'

/**
 * session과 generation 서비스를 하나의 SQLite 데이터베이스 파일로 함께 제공합니다. 두 서비스가 같은
 * 연결을 공유하므로 실행 종료 기록과 세션 커밋이 하나의 트랜잭션으로 확정됩니다. 연결은 등록한
 * 서비스가 모두 해제되면 닫히고, 같은 경로로 다시 등록하면 저장된 상태를 이어받습니다.
 */
export const sqliteStorePlugin = Object.assign(
  function sqliteStorePlugin(ctx: Context, config: SqliteStoreConfig) {
    const store = new SqliteStore(config.path)
    ctx.fiber.effect(() => () => store.release())
    new SqliteSessionService(ctx, store)
    ctx.inject(['llm', 'session'], (injected) => {
      new SqliteGenerationService(injected, store)
    })
  },
  { Config: sqliteStoreConfigSchema }
)

export default sqliteStorePlugin
