import { MessageAssembly, parseAGUIEvent, parseRunAgentInput } from '@keundal/core'
import type { GenerationSnapshot } from '@keundal/generation'
import { parseReasoning } from '@keundal/llm'
import type { SessionSnapshot } from '@keundal/session'
import { Service, type Context } from 'cordis'

export interface HistoryBackup {
  readonly threads: SessionSnapshot[]
  readonly runs: GenerationSnapshot[]
}

export abstract class BackupService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'backup')
  }

  /** Returns a detached snapshot; refuses any stored running generation. */
  abstract export(): Promise<HistoryBackup>
  /** Atomically adds history; refuses running records and any existing threadId or runId. */
  abstract import(data: HistoryBackup): Promise<void>
}

declare module 'cordis' {
  interface Context {
    readonly backup: BackupService
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid backup object')
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('unknown backup field')
  return value as Record<string, unknown>
}

function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid backup ID')
}

function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid backup integer')
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('invalid backup array')
  return value
}

function unique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error('duplicate backup ID')
}

function messages(value: unknown): void {
  array(value)
  const parsed = parseRunAgentInput({
    threadId: 'backup',
    runId: 'backup',
    state: {},
    tools: [],
    context: [],
    messages: value
  }).messages
  unique(
    parsed.map((message) => {
      id(message.id)
      return message.id
    })
  )
  for (const message of parsed) {
    if (message.role === 'tool') id(message.toolCallId)
    if (message.role === 'assistant' && message.toolCalls) {
      unique(
        message.toolCalls.map((call) => {
          id(call.id)
          return call.id
        })
      )
    }
  }
}

// Reject values which would silently change when the portable snapshot is JSON encoded.
function portable(value: unknown, ancestors = new Set<object>()): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('backup must contain portable JSON values')
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error('backup must contain plain objects')
  ancestors.add(value)
  for (const item of Object.values(value)) portable(item, ancestors)
  ancestors.delete(value)
}

/** Validates without normalizing away message metadata, state, request or journal fields. */
export function parseHistoryBackup(value: unknown): HistoryBackup {
  portable(value)
  const data = object(value, ['threads', 'runs'])
  const threads = array(data.threads).map((value) => {
    const thread = object(value, ['threadId', 'revision', 'messages', 'state', 'metadata'])
    id(thread.threadId)
    integer(thread.revision)
    messages(thread.messages)
    if (thread.metadata !== undefined) {
      if (!thread.metadata || typeof thread.metadata !== 'object' || Array.isArray(thread.metadata))
        throw new Error('invalid backup metadata')
    }
    return thread as unknown as SessionSnapshot
  })
  unique(threads.map((thread) => thread.threadId))
  const threadRevisions = new Map(threads.map((thread) => [thread.threadId, thread.revision]))
  const runs = array(data.runs).map((value) => {
    const run = object(value, ['request', 'status', 'journal', 'messages', 'state'])
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status as string))
      throw new Error('backup cannot contain running or unknown generation status')
    const request = object(run.request, [
      'input',
      'model',
      'maxOutputTokens',
      'webSearch',
      'reasoning',
      'sessionRevision',
      'compaction'
    ])
    const input = parseRunAgentInput(request.input)
    id(input.threadId)
    id(input.runId)
    messages(input.messages)
    if (!threadRevisions.has(input.threadId)) throw new Error('backup run references a missing thread')
    integer(request.sessionRevision)
    if (request.sessionRevision > threadRevisions.get(input.threadId)!)
      throw new Error('backup run revision exceeds thread revision')
    id(request.model)
    integer(request.maxOutputTokens)
    if (!request.maxOutputTokens) throw new Error('invalid backup output token limit')
    if (request.webSearch !== undefined && typeof request.webSearch !== 'boolean') throw new Error('invalid webSearch')
    parseReasoning(request.reasoning)
    if (request.compaction !== undefined) {
      const compaction = object(request.compaction, ['messages', 'summary', 'sourceMessageIds'])
      messages(compaction.messages)
      if (typeof compaction.summary !== 'string') throw new Error('invalid backup summary')
      const ids = array(compaction.sourceMessageIds).map((value) => {
        id(value)
        return value
      })
      unique(ids)
    }
    messages(run.messages)
    const assembly = new MessageAssembly((request.input as typeof input).state)
    array(run.journal).forEach((value, sequence) => {
      const entry = object(value, ['sequence', 'event'])
      if (entry.sequence !== sequence) throw new Error('backup journal sequences must be contiguous from zero')
      const event = parseAGUIEvent(entry.event)
      if ('threadId' in event && event.threadId !== input.threadId) throw new Error('backup event thread mismatch')
      if ('runId' in event && event.runId !== input.runId) throw new Error('backup event run mismatch')
      for (const key of ['messageId', 'parentMessageId', 'toolCallId', 'entityId'] as const) {
        if (key in event && event[key as keyof typeof event] !== undefined)
          id((event as unknown as Record<string, unknown>)[key])
      }
      assembly.apply(event)
    })
    messages(assembly.messages)
    return { ...run, state: assembly.state } as unknown as GenerationSnapshot
  })
  unique(runs.map((run) => run.request.input.runId))
  return globalThis.structuredClone({ threads, runs })
}
