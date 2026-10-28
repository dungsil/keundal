import type { ExecutionOptions } from '@keundal/core'
import { Service, type Context } from 'cordis'
import { z } from 'zod'

export const memoryTextSchema = z.string().trim().min(1)
export const memoryContentSchema = z.strictObject({
  title: memoryTextSchema,
  content: memoryTextSchema,
  sources: z.array(z.strictObject({ uri: memoryTextSchema, label: memoryTextSchema.optional() })).min(1)
})
export const memoryRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const memorySearchSchema = z.strictObject({
  query: memoryTextSchema,
  limit: z.number().int().min(1).max(50).default(10)
})

export type MemoryContent = z.infer<typeof memoryContentSchema>

export interface ProjectMemory extends MemoryContent {
  readonly id: string
  readonly projectId: string
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
}

declare module 'cordis' {
  interface Context {
    readonly memory: MemoryService
    readonly scopedMemory: ScopedMemoryService
  }
}

/** Project IDs are assigned by the application, not inferred from conversation text. */
export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  abstract create(projectId: string, content: MemoryContent, options?: ExecutionOptions): Promise<ProjectMemory>
  abstract get(projectId: string, id: string, options?: ExecutionOptions): Promise<ProjectMemory | undefined>
  abstract search(
    projectId: string,
    query: { query: string; limit?: number },
    options?: ExecutionOptions
  ): Promise<ProjectMemory[]>
  /** Replaces the content and sources only if the revision still matches. */
  abstract update(
    projectId: string,
    id: string,
    expectedRevision: number,
    content: MemoryContent,
    options?: ExecutionOptions
  ): Promise<ProjectMemory>
  abstract delete(projectId: string, id: string, expectedRevision: number, options?: ExecutionOptions): Promise<void>
}

const scopeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('user') }),
  z.strictObject({ type: z.literal('project'), id: memoryTextSchema }),
  z.strictObject({ type: z.literal('conversation'), id: memoryTextSchema })
])
const draftSchema = memoryContentSchema.extend({ scope: scopeSchema })
const entrySchema = draftSchema.extend({
  id: memoryTextSchema,
  revision: memoryRevisionSchema,
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative()
})
const searchQuerySchema = z.strictObject({
  text: memoryTextSchema,
  projectId: memoryTextSchema.optional(),
  threadId: memoryTextSchema.optional(),
  limit: z.number().int().min(1).max(20).optional()
})

export type MemoryScope = z.infer<typeof scopeSchema>
export interface MemoryDraft extends MemoryContent {
  scope: MemoryScope
}
export interface MemoryEntry extends MemoryDraft {
  id: string
  revision: number
  createdAt: number
  updatedAt: number
}
export type MemorySearchQuery = z.infer<typeof searchQuerySchema>
export const parseMemoryDraft = (value: unknown): MemoryDraft => draftSchema.parse(value)
export const parseMemoryEntry = (value: unknown): MemoryEntry => entrySchema.parse(value)
export const parseMemoryId = (value: unknown): string => memoryTextSchema.parse(value)
export const parseMemorySearchQuery = (value: unknown): MemorySearchQuery => searchQuerySchema.parse(value)

export abstract class ScopedMemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'scopedMemory')
  }

  abstract list(options?: ExecutionOptions): Promise<MemoryEntry[]>
  abstract save(
    draft: MemoryDraft,
    id?: string,
    expectedRevision?: number,
    options?: ExecutionOptions
  ): Promise<MemoryEntry>
  abstract delete(id: string, expectedRevision: number, options?: ExecutionOptions): Promise<void>
  abstract search(query: MemorySearchQuery, options?: ExecutionOptions): Promise<MemoryEntry[]>
}
