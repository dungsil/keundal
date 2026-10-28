import type { ExecutionOptions } from '@keundal/core'
import {
  MemoryService,
  ScopedMemoryService,
  memoryContentSchema,
  memoryRevisionSchema,
  memorySearchSchema,
  memoryTextSchema,
  parseMemoryDraft,
  parseMemoryEntry,
  parseMemoryId,
  parseMemorySearchQuery,
  type MemoryAdapter,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryContent,
  type ProjectMemory,
  type MemorySearchQuery
} from '@keundal/memory'
import type { Context } from 'cordis'

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const normalize = (text: string): string => text.normalize('NFKC').toLowerCase()
const words = (text: string): string[] => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []
const matches = (tokens: string[], term: string): boolean =>
  tokens.some(
    (token) =>
      token === term ||
      (/\p{Script=Hangul}/u.test(term) && token.includes(term)) ||
      (token.startsWith(term) && /^\p{Script=Hangul}+$/u.test(token.slice(term.length)))
  )

export class StoredMemoryService extends ScopedMemoryService {
  private closed = false

  constructor(
    ctx: Context,
    private readonly adapter: MemoryAdapter
  ) {
    super(ctx)
    ctx.fiber.effect(() => () => {
      this.closed = true
    })
  }

  private check(options?: ExecutionOptions): void {
    if (this.closed) throw new Error('memory service is disposed')
    options?.signal?.throwIfAborted()
  }

  async list(options?: ExecutionOptions): Promise<MemoryEntry[]> {
    this.check(options)
    const entries = await this.adapter.list(options)
    this.check(options)
    return entries.map(parseMemoryEntry).sort((a, b) => a.createdAt - b.createdAt || compare(a.id, b.id))
  }

  async save(
    draft: MemoryDraft,
    id?: string,
    expectedRevision?: number,
    options?: ExecutionOptions
  ): Promise<MemoryEntry> {
    this.check(options)
    const parsed = parseMemoryDraft(draft)
    if (id !== undefined) memoryRevisionSchema.parse(expectedRevision)
    else if (expectedRevision !== undefined) throw new Error('creation cannot specify a revision')
    const entryId = id === undefined ? globalThis.crypto.randomUUID() : parseMemoryId(id)
    const previous = id === undefined ? undefined : (await this.list(options)).find((entry) => entry.id === entryId)
    if (id !== undefined && !previous) throw new Error(`memory entry does not exist: ${entryId}`)
    if (previous && previous.revision !== expectedRevision) throw new Error('memory revision conflict')
    this.check(options)
    const now = Date.now()
    const entry: MemoryEntry = {
      ...parsed,
      id: entryId,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    }
    await this.adapter.save(parseMemoryEntry(entry), { ...options, update: id !== undefined, expectedRevision })
    return parseMemoryEntry(entry)
  }

  async delete(id: string, expectedRevision: number, options?: ExecutionOptions): Promise<void> {
    this.check(options)
    await this.adapter.delete(parseMemoryId(id), memoryRevisionSchema.parse(expectedRevision), options)
  }

  async search(query: MemorySearchQuery, options?: ExecutionOptions): Promise<MemoryEntry[]> {
    this.check(options)
    const parsed = parseMemorySearchQuery(query)
    const terms = [...new Set(words(parsed.text))]
    if (!terms.length) return []
    const entries = await this.list(options)
    return entries
      .filter(
        ({ scope }) =>
          scope.type === 'user' ||
          (scope.type === 'project' && scope.id === parsed.projectId) ||
          (scope.type === 'conversation' && scope.id === parsed.threadId)
      )
      .map((entry) => {
        const content = words(entry.content)
        const label = words([entry.title, ...entry.sources.map((source) => source.label ?? '')].join(' '))
        const score = terms.reduce(
          (sum, term) => sum + (matches(content, term) ? 2 : 0) + (matches(label, term) ? 1 : 0),
          0
        )
        return { entry, score }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt || compare(a.entry.id, b.entry.id))
      .slice(0, parsed.limit ?? 20)
      .map(({ entry }) => entry)
  }
}

const projectSnapshot = (entry: MemoryEntry): ProjectMemory => {
  if (entry.scope.type !== 'project') throw new Error('not a project memory')
  const { scope, ...record } = entry
  return { ...record, projectId: scope.id }
}

/** Project contract over the same scoped records, with the project's literal search semantics. */
export class StoredProjectMemoryService extends MemoryService {
  constructor(
    ctx: Context,
    private readonly scoped: ScopedMemoryService
  ) {
    super(ctx)
  }

  async create(projectId: string, content: MemoryContent, options?: ExecutionOptions): Promise<ProjectMemory> {
    return projectSnapshot(
      await this.scoped.save(
        { ...memoryContentSchema.parse(content), scope: { type: 'project', id: memoryTextSchema.parse(projectId) } },
        undefined,
        undefined,
        options
      )
    )
  }

  async get(projectId: string, id: string, options?: ExecutionOptions): Promise<ProjectMemory | undefined> {
    projectId = memoryTextSchema.parse(projectId)
    id = memoryTextSchema.parse(id)
    const entry = (await this.scoped.list(options)).find(
      (entry) => entry.id === id && entry.scope.type === 'project' && entry.scope.id === projectId
    )
    return entry && projectSnapshot(entry)
  }

  async search(
    projectId: string,
    query: { query: string; limit?: number },
    options?: ExecutionOptions
  ): Promise<ProjectMemory[]> {
    projectId = memoryTextSchema.parse(projectId)
    const parsed = memorySearchSchema.parse(query)
    const terms = [...new Set(parsed.query.split(/\s+/u))].map((term) => term.toLowerCase())
    return (await this.scoped.list(options))
      .filter(
        (entry) =>
          entry.scope.type === 'project' &&
          entry.scope.id === projectId &&
          terms.every((term) => `${entry.title}\n${entry.content}`.toLowerCase().includes(term))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || compare(a.id, b.id))
      .slice(0, parsed.limit)
      .map(projectSnapshot)
  }

  async update(
    projectId: string,
    id: string,
    expectedRevision: number,
    content: MemoryContent,
    options?: ExecutionOptions
  ): Promise<ProjectMemory> {
    const previous = await this.get(projectId, id, options)
    if (!previous) throw new Error('memory not found or revision conflict')
    return projectSnapshot(
      await this.scoped.save(
        { ...memoryContentSchema.parse(content), scope: { type: 'project', id: previous.projectId } },
        id,
        expectedRevision,
        options
      )
    )
  }

  async delete(projectId: string, id: string, expectedRevision: number, options?: ExecutionOptions): Promise<void> {
    if (!(await this.get(projectId, id, options))) throw new Error('memory not found or revision conflict')
    await this.scoped.delete(id, expectedRevision, options)
  }
}
