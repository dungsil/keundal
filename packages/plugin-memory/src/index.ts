import type { ExecutionOptions } from '@keundal/core'
import {
  MemoryService,
  parseMemoryDraft,
  parseMemoryEntry,
  parseMemoryId,
  parseMemorySearchQuery,
  type MemoryDraft,
  type MemoryEntry,
  type MemorySearchQuery
} from '@keundal/memory'
import type { Context } from 'cordis'

export interface MemoryAdapterSaveOptions extends ExecutionOptions {
  /** Updates must atomically reject missing IDs rather than recreate deleted entries. */
  readonly update: boolean
}

export interface MemoryAdapter {
  list(options?: ExecutionOptions): Promise<MemoryEntry[]>
  /** Creates must reject duplicate IDs; updates must reject missing IDs. */
  save(entry: MemoryEntry, options: MemoryAdapterSaveOptions): Promise<void>
  delete(id: string, options?: ExecutionOptions): Promise<void>
}

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

export class StoredMemoryService extends MemoryService {
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
    return entries.map(parseMemoryEntry).sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))
  }

  async save(draft: MemoryDraft, id?: string, options?: ExecutionOptions): Promise<MemoryEntry> {
    this.check(options)
    const parsed = parseMemoryDraft(draft)
    const entryId = id === undefined ? globalThis.crypto.randomUUID() : parseMemoryId(id)
    const previous = id === undefined ? undefined : (await this.list(options)).find((entry) => entry.id === entryId)
    if (id !== undefined && !previous) throw new Error(`memory entry does not exist: ${entryId}`)
    this.check(options)
    const now = new Date().toISOString()
    const entry: MemoryEntry = { ...parsed, id: entryId, createdAt: previous?.createdAt ?? now, updatedAt: now }
    await this.adapter.save(parseMemoryEntry(entry), { ...options, update: id !== undefined })
    return parseMemoryEntry(entry)
  }

  async delete(id: string, options?: ExecutionOptions): Promise<void> {
    this.check(options)
    await this.adapter.delete(parseMemoryId(id), options)
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
        const label = words(entry.source.label)
        const score = terms.reduce(
          (sum, term) => sum + (matches(content, term) ? 2 : 0) + (matches(label, term) ? 1 : 0),
          0
        )
        return { entry, score }
      })
      .filter(({ score }) => score > 0)
      .sort(
        (a, b) => b.score - a.score || compare(b.entry.updatedAt, a.entry.updatedAt) || compare(a.entry.id, b.entry.id)
      )
      .slice(0, parsed.limit ?? 20)
      .map(({ entry }) => entry)
  }
}

export interface MemoryPluginConfig {
  adapter: MemoryAdapter
}

export function memoryPlugin(ctx: Context, config: MemoryPluginConfig): void {
  new StoredMemoryService(ctx, config.adapter)
}

export default memoryPlugin
