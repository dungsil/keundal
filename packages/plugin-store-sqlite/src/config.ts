import type { StandardSchemaV1 } from '@standard-schema/spec'

export interface SqliteStoreConfig {
  /** SQLite 데이터베이스 파일 경로입니다. `:memory:`를 전달하면 프로세스 메모리에만 저장합니다. */
  readonly path: string
}

function parseConfig(value: unknown): SqliteStoreConfig {
  if (typeof value !== 'object' || value === null) throw new Error('SQLite store configuration must be an object')
  const path: unknown = Reflect.get(value, 'path')
  if (typeof path !== 'string' || !path.trim()) throw new Error('path must be a non-empty SQLite database path')
  return { path }
}

export const sqliteStoreConfigSchema: StandardSchemaV1<SqliteStoreConfig, SqliteStoreConfig> = {
  '~standard': {
    version: 1,
    vendor: 'keundal',
    validate(value) {
      try {
        return { value: parseConfig(value) }
      } catch (error) {
        return {
          issues: [{ message: error instanceof Error ? error.message : 'invalid SQLite store configuration' }]
        }
      }
    }
  }
}
