import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify, TextDecoder } from 'node:util'

import { EventType, type ExecutionOptions, type LLMEvent } from '@keundal/core'

import { compareLines, WORKSPACE_CHANGES_EVENT, type FileChange, type WorkspaceChanges } from './shared.js'

const exec = promisify(execFile)
export interface WorkspaceChangesOptions {
  readonly cwd: string
  readonly maxFiles?: number
  readonly maxFileBytes?: number
  readonly maxSnapshotBytes?: number
}
interface SnapshotFile {
  fingerprint: string
  content?: string
  reason?: FileChange['reason']
}
type Snapshot = Map<string, SnapshotFile>

export function recordWorkspaceChanges(config: WorkspaceChangesOptions) {
  const maxFiles = config.maxFiles ?? 500
  const maxFileBytes = config.maxFileBytes ?? 64 * 1024
  const maxSnapshotBytes = config.maxSnapshotBytes ?? 512 * 1024
  for (const [name, value] of Object.entries({ maxFiles, maxFileBytes, maxSnapshotBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  }
  if (maxFiles > 500) throw new Error('maxFiles must not exceed 500')
  if (!config.cwd.trim()) throw new Error('workspace cwd is required')

  async function snapshot(signal?: AbortSignal, baseline?: Snapshot): Promise<Snapshot> {
    signal?.throwIfAborted()
    const cwd = await realpath(config.cwd)
    // ls-files reads the existing index without changing it or running clean filters.
    const { stdout } = await exec(
      'git',
      ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      {
        signal,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8'
      }
    )
    const files = [...new Set([...stdout.split('\0').filter(Boolean), ...(baseline?.keys() ?? [])])].sort()
    if (files.length > maxFiles) throw new Error('workspace file limit exceeded')
    const result: Snapshot = new Map()
    let retained = 0
    for (const file of files) {
      signal?.throwIfAborted()
      const absolute = path.resolve(cwd, file)
      const relative = path.relative(cwd, absolute)
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) continue
      try {
        const stat = await lstat(absolute, { bigint: true })
        const fingerprint = [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':')
        if (!stat.isFile() || (await realpath(absolute)) !== absolute) {
          result.set(file, { fingerprint, reason: 'unsupported' })
          continue
        }
        if (stat.size > BigInt(maxFileBytes)) {
          result.set(file, { fingerprint, reason: 'oversized' })
          continue
        }
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const opened = await handle.stat()
          if (!opened.isFile()) throw new Error('not a regular file')
          const bytes = Buffer.alloc(maxFileBytes + 1)
          let length = 0
          while (length < bytes.length) {
            signal?.throwIfAborted()
            const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
            if (!bytesRead) break
            length += bytesRead
          }
          const buffer = bytes.subarray(0, length)
          const hash = createHash('sha256').update(buffer).digest('hex')
          let reason: FileChange['reason']
          let content: string | undefined
          if (length > maxFileBytes) reason = 'oversized'
          else if (buffer.includes(0)) reason = 'binary'
          else if (retained + length > maxSnapshotBytes) reason = 'budget'
          else {
            try {
              content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
            } catch {
              reason = 'binary'
            }
            if (content !== undefined) retained += length
          }
          result.set(file, { fingerprint: length > maxFileBytes ? fingerprint : hash, content, reason })
        } finally {
          await handle.close()
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
        result.set(file, { fingerprint: 'unreadable', reason: 'unreadable' })
      }
    }
    return result
  }

  function changes(before: Snapshot, after: Snapshot, ignored: string[]): FileChange[] {
    const files: FileChange[] = []
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const original = before.get(name)
      const updated = after.get(name)
      if (original && updated && original.fingerprint === updated.fingerprint && original.reason !== 'unreadable')
        continue
      const change: FileChange = { path: name, kind: !original ? 'added' : !updated ? 'deleted' : 'modified' }
      const excludedAtStart =
        !original && ignored.some((entry) => name === entry || (entry.endsWith('/') && name.startsWith(entry)))
      if (excludedAtStart) change.kind = 'modified'
      const reason = excludedAtStart ? 'baseline' : (original?.reason ?? updated?.reason)
      if (reason) change.reason = reason
      else {
        change.before = original?.content ?? null
        change.after = updated?.content ?? null
        const diff = compareLines(change.before ?? '', change.after ?? '')
        change.additions = diff.additions
        change.deletions = diff.deletions
        if (diff.coarse) change.coarse = true
      }
      files.push(change)
      if (files.length > maxFiles) throw new Error('workspace change limit exceeded')
    }
    return files
  }

  return async function* (
    events: AsyncIterable<LLMEvent>,
    input: { threadId: string; runId: string },
    options: ExecutionOptions = {}
  ): AsyncGenerator<LLMEvent> {
    let baseline: Snapshot | undefined
    let ignored: string[] = []
    try {
      const cwd = await realpath(config.cwd)
      const { stdout } = await exec(
        'git',
        ['-C', cwd, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', '.'],
        {
          signal: options.signal,
          timeout: 10_000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8'
        }
      )
      ignored = stdout.split('\0').filter(Boolean)
      baseline = await snapshot(options.signal)
    } catch {
      options.signal?.throwIfAborted()
    }
    const update = async (status: 'partial' | 'complete'): Promise<LLMEvent> => {
      let value: WorkspaceChanges = { version: 1, runId: input.runId, status: 'unavailable', files: [] }
      if (baseline) {
        try {
          value = { ...value, status, files: changes(baseline, await snapshot(options.signal, baseline), ignored) }
        } catch {
          options.signal?.throwIfAborted()
        }
      }
      return { type: EventType.CUSTOM, name: WORKSPACE_CHANGES_EVENT, value }
    }
    try {
      for await (const event of events) {
        yield event
        if (event.type === EventType.TOOL_CALL_RESULT) yield await update('partial')
      }
    } catch (error) {
      if (!options.signal?.aborted) yield await update('partial')
      throw error
    }
    yield await update('complete')
  }
}
