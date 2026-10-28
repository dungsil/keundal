import type { ExecutionOptions } from '@keundal/core'
import {
  MemoryService,
  type MemoryContent,
  type ProjectMemory,
  memoryContentSchema,
  memoryRevisionSchema,
  memorySearchSchema,
  memoryTextSchema
} from '@keundal/memory'
import type { Context } from 'cordis'

import type { SqliteStore } from './store.js'

interface MemoryRow {
  id: string
  project_id: string
  title: string
  content: string
  sources: string
  revision: number
  created_at: number
  updated_at: number
}

const snapshot = (row: MemoryRow): ProjectMemory => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  content: row.content,
  sources: JSON.parse(row.sources),
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

export class SqliteMemoryService extends MemoryService {
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: SqliteStore
  ) {
    super(ctx)
    store.retain()
    ctx.fiber.effect(() => () => {
      this.closed = true
      store.release()
    })
  }

  async create(projectId: string, content: MemoryContent, options?: ExecutionOptions): Promise<ProjectMemory> {
    this.check(options)
    projectId = memoryTextSchema.parse(projectId)
    const parsed = memoryContentSchema.parse(content)
    const id = globalThis.crypto.randomUUID()
    const now = Date.now()
    this.store.database
      .prepare(`INSERT INTO project_memories
      (id, project_id, title, content, sources, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, projectId, parsed.title, parsed.content, JSON.stringify(parsed.sources), now, now)
    return { ...parsed, id, projectId, revision: 1, createdAt: now, updatedAt: now }
  }

  async get(projectId: string, id: string, options?: ExecutionOptions): Promise<ProjectMemory | undefined> {
    this.check(options)
    const row = this.store.database
      .prepare('SELECT * FROM project_memories WHERE project_id = ? AND id = ?')
      .get(memoryTextSchema.parse(projectId), memoryTextSchema.parse(id))
    return row ? snapshot(row as unknown as MemoryRow) : undefined
  }

  async search(
    projectId: string,
    query: { query: string; limit?: number },
    options?: ExecutionOptions
  ): Promise<ProjectMemory[]> {
    this.check(options)
    projectId = memoryTextSchema.parse(projectId)
    const parsed = memorySearchSchema.parse(query)
    const terms = [...new Set(parsed.query.split(/\s+/u))]
    // Literal substring matching also supports short Korean terms without FTS tokenization or query syntax.
    const conditions = terms.map(() => 'instr(lower(title || char(10) || content), lower(?)) > 0').join(' AND ')
    const rows = this.store.database
      .prepare(`SELECT * FROM project_memories
      WHERE project_id = ? AND ${conditions} ORDER BY updated_at DESC, id LIMIT ?`)
      .all(projectId, ...terms, parsed.limit)
    return (rows as unknown as MemoryRow[]).map(snapshot)
  }

  async update(
    projectId: string,
    id: string,
    expectedRevision: number,
    content: MemoryContent,
    options?: ExecutionOptions
  ): Promise<ProjectMemory> {
    this.check(options)
    projectId = memoryTextSchema.parse(projectId)
    id = memoryTextSchema.parse(id)
    memoryRevisionSchema.parse(expectedRevision)
    const parsed = memoryContentSchema.parse(content)
    const row = this.store.database
      .prepare(`UPDATE project_memories SET title = ?, content = ?, sources = ?,
      revision = revision + 1, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ? RETURNING *`)
      .get(parsed.title, parsed.content, JSON.stringify(parsed.sources), Date.now(), projectId, id, expectedRevision)
    if (!row) throw new Error('memory not found or revision conflict')
    return snapshot(row as unknown as MemoryRow)
  }

  async delete(projectId: string, id: string, expectedRevision: number, options?: ExecutionOptions): Promise<void> {
    this.check(options)
    const result = this.store.database
      .prepare('DELETE FROM project_memories WHERE project_id = ? AND id = ? AND revision = ?')
      .run(memoryTextSchema.parse(projectId), memoryTextSchema.parse(id), memoryRevisionSchema.parse(expectedRevision))
    if (!result.changes) throw new Error('memory not found or revision conflict')
  }

  private check(options?: ExecutionOptions): void {
    if (this.closed) throw new Error('SQLite memory service disposed')
    options?.signal?.throwIfAborted()
  }
}
