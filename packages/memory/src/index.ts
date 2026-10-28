import type { ExecutionOptions } from '@keundal/core'
import { Service, type Context } from 'cordis'

export type MemoryScope = { type: 'user' } | { type: 'project'; id: string } | { type: 'conversation'; id: string }

export interface MemoryDraft {
  scope: MemoryScope
  content: string
  source: { label: string; threadId?: string; messageId?: string }
}

export interface MemoryEntry extends MemoryDraft {
  id: string
  createdAt: string
  updatedAt: string
}

export interface MemorySearchQuery {
  text: string
  projectId?: string
  threadId?: string
  limit?: number
}

export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  abstract list(options?: ExecutionOptions): Promise<MemoryEntry[]>
  abstract save(draft: MemoryDraft, id?: string, options?: ExecutionOptions): Promise<MemoryEntry>
  abstract delete(id: string, options?: ExecutionOptions): Promise<void>
  abstract search(query: MemorySearchQuery, options?: ExecutionOptions): Promise<MemoryEntry[]>
}

declare module 'cordis' {
  interface Context {
    readonly memory: MemoryService
  }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected an object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('expected a plain object')
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError('unknown memory field')
  return value as Record<string, unknown>
}

function string(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`)
  return value
}

export function parseMemoryDraft(value: unknown): MemoryDraft {
  const draft = object(value, ['scope', 'content', 'source'])
  const scope = object(draft.scope, ['type', 'id'])
  let parsedScope: MemoryScope
  if (scope.type === 'user') {
    if ('id' in scope) throw new TypeError('user scope cannot have an id')
    parsedScope = { type: 'user' }
  } else if (scope.type === 'project' || scope.type === 'conversation') {
    parsedScope = { type: scope.type, id: string(scope.id, 200, 'scope.id') }
  } else throw new TypeError('invalid memory scope')
  const source = object(draft.source, ['label', 'threadId', 'messageId'])
  return {
    scope: parsedScope,
    content: string(draft.content, 4000, 'content'),
    source: {
      label: string(source.label, 200, 'source.label'),
      ...(source.threadId === undefined ? {} : { threadId: string(source.threadId, 200, 'source.threadId') }),
      ...(source.messageId === undefined ? {} : { messageId: string(source.messageId, 200, 'source.messageId') })
    }
  }
}

export function parseMemoryId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new TypeError('memory id must be a UUID v4')
  return value
}

export function parseMemoryEntry(value: unknown): MemoryEntry {
  const entry = object(value, ['id', 'scope', 'content', 'source', 'createdAt', 'updatedAt'])
  const timestamp = (value: unknown): string => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
      throw new TypeError('memory timestamps must be ISO timestamps')
    return value
  }
  return {
    ...parseMemoryDraft({ scope: entry.scope, content: entry.content, source: entry.source }),
    id: parseMemoryId(entry.id),
    createdAt: timestamp(entry.createdAt),
    updatedAt: timestamp(entry.updatedAt)
  }
}

export function parseMemorySearchQuery(value: unknown): MemorySearchQuery {
  const query = object(value, ['text', 'projectId', 'threadId', 'limit'])
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || (query.limit as number) < 1 || (query.limit as number) > 20)
  )
    throw new TypeError('memory search limit must be an integer between 1 and 20')
  return {
    text: string(query.text, 4000, 'text'),
    ...(query.projectId === undefined ? {} : { projectId: string(query.projectId, 200, 'projectId') }),
    ...(query.threadId === undefined ? {} : { threadId: string(query.threadId, 200, 'threadId') }),
    ...(query.limit === undefined ? {} : { limit: query.limit as number })
  }
}
