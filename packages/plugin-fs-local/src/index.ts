import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readdir, readlink, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import type { ExecutionOptions } from '@keundal/core'
import {
  FileSystemService,
  type DirectoryEntry,
  type FileEdit,
  type FileMutation,
  type FileMutationOptions,
  type FileSnapshot,
  type FileSystemOptions
} from '@keundal/fs'
import type { Context } from 'cordis'

export interface LocalFileSystemConfig {
  readonly cwd?: string
  readonly maxFileBytes?: number
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export class LocalFileSystemService extends FileSystemService {
  private readonly cwd: string
  private readonly maxFileBytes: number
  private readonly pending = new Map<string, Promise<void>>()
  private readonly lifetime = new globalThis.AbortController()

  constructor(ctx: Context, config: LocalFileSystemConfig = {}) {
    super(ctx)
    this.cwd = config.cwd ?? process.cwd()
    this.maxFileBytes = config.maxFileBytes ?? 1024 * 1024
    if (this.cwd.includes('\0')) throw new Error('cwd must not contain NUL')
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 0)
      throw new Error('maxFileBytes must be a non-negative safe integer')
    ctx.fiber.effect(() => () => this.lifetime.abort(new Error('file system disposed')))
  }

  private withLifetime<T extends ExecutionOptions>(options: T): T {
    return {
      ...options,
      signal: options.signal ? globalThis.AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal
    }
  }

  async resolve(input: string, options: ExecutionOptions = {}): Promise<string> {
    options = this.withLifetime(options)
    options.signal?.throwIfAborted()
    if (input.includes('\0')) throw new Error('path must not contain NUL')
    const absolute = path.isAbsolute(input)
      ? input
      : `${path.isAbsolute(this.cwd) ? this.cwd : `${process.cwd()}${path.sep}${this.cwd}`}${path.sep}${input}`
    let current = path.parse(absolute).root
    const split = (value: string) => value.split(process.platform === 'win32' ? /[\\/]/ : /\//)
    let parts = split(absolute.slice(current.length))
    let links = 0
    while (parts.length) {
      options.signal?.throwIfAborted()
      const part = parts.shift()!
      if (!part || part === '.') continue
      if (part === '..') {
        current = path.dirname(current)
        continue
      }
      const next = path.join(current, part)
      try {
        options.signal?.throwIfAborted()
        const stat = await lstat(next)
        if (stat.isSymbolicLink()) {
          if (++links > 40) throw new Error('too many symbolic links')
          options.signal?.throwIfAborted()
          const target = await readlink(next)
          if (path.isAbsolute(target)) current = path.parse(target).root
          parts = [...split(target.slice(path.isAbsolute(target) ? path.parse(target).root.length : 0)), ...parts]
          continue
        }
        options.signal?.throwIfAborted()
        current = await realpath(next)
        continue
      } catch (error) {
        if (!missing(error)) throw error
      }
      current = next
    }
    options.signal?.throwIfAborted()
    return current
  }

  contains(root: string, target: string): boolean {
    const relative = path.relative(root, target)
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  }

  private async snapshot(canonical: string, options: ExecutionOptions): Promise<FileSnapshot & { mode: number }> {
    options.signal?.throwIfAborted()
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      options.signal?.throwIfAborted()
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile()) throw new Error('path must be a regular file')
      if (stat.size > BigInt(this.maxFileBytes)) throw new Error('file exceeds maxFileBytes')
      const buffer = Buffer.alloc(this.maxFileBytes + 1)
      let length = 0
      while (length < buffer.length) {
        options.signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > this.maxFileBytes) throw new Error('file exceeds maxFileBytes')
      options.signal?.throwIfAborted()
      const after = await handle.stat({ bigint: true })
      const metadata = (value: typeof stat) =>
        [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode].join(':')
      if (metadata(stat) !== metadata(after)) throw new Error('file changed while reading')
      const bytes = buffer.subarray(0, length)
      const version = createHash('sha256').update(metadata(after)).update(bytes).digest('hex')
      return { path: canonical, content: bytes.toString('utf8'), version, mode: Number(after.mode) }
    } finally {
      await handle.close()
    }
  }

  async read(input: string, options: FileSystemOptions = {}): Promise<FileSnapshot> {
    options = this.withLifetime(options)
    const { mode: _mode, ...snapshot } = await this.snapshot(await this.resolve(input, options), options)
    return snapshot
  }

  async list(input: string, options: FileSystemOptions = {}): Promise<readonly DirectoryEntry[]> {
    options = this.withLifetime(options)
    const canonical = await this.resolve(input, options)
    options.signal?.throwIfAborted()
    const entries = await readdir(canonical, { withFileTypes: true })
    options.signal?.throwIfAborted()
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
    }))
  }

  write(input: string, content: string, options: FileMutationOptions = {}): Promise<FileMutation> {
    return this.mutate(input, () => content, options)
  }

  edit(input: string, edit: FileEdit, options: FileMutationOptions = {}): Promise<FileMutation> {
    return this.mutate(
      input,
      (snapshot) => {
        if (!snapshot || typeof options.expectedVersion !== 'string')
          throw new Error('edit requires an observed version')
        const index = snapshot.content.indexOf(edit.oldText)
        if (!edit.oldText || index < 0 || snapshot.content.indexOf(edit.oldText, index + 1) >= 0)
          throw new Error('oldText must occur exactly once and must not be empty')
        return snapshot.content.slice(0, index) + edit.newText + snapshot.content.slice(index + edit.oldText.length)
      },
      options
    )
  }

  private async mutate(
    input: string,
    content: (snapshot: FileSnapshot | undefined) => string,
    options: FileMutationOptions
  ): Promise<FileMutation> {
    options = this.withLifetime(options)
    const canonical = await this.resolve(input, options)
    const previous = this.pending.get(canonical) ?? Promise.resolve()
    const turn = Promise.withResolvers<void>()
    this.pending.set(canonical, turn.promise)
    let staging: string | undefined
    try {
      await previous
      options.signal?.throwIfAborted()
      let observed: (FileSnapshot & { mode: number }) | undefined
      try {
        observed = await this.snapshot(canonical, options)
      } catch (error) {
        if (!missing(error)) throw error
      }
      if (
        typeof options.expectedVersion === 'string'
          ? observed?.version !== options.expectedVersion
          : observed !== undefined
      )
        throw new Error('file version conflict')
      const bytes = Buffer.from(content(observed), 'utf8')
      if (bytes.length > this.maxFileBytes) throw new Error('file exceeds maxFileBytes')
      staging = path.join(path.dirname(canonical), `.keundal-${randomUUID()}.tmp`)
      options.signal?.throwIfAborted()
      const handle = await open(staging, 'wx', observed ? observed.mode & 0o7777 : 0o666)
      try {
        options.signal?.throwIfAborted()
        await handle.writeFile(bytes, { signal: options.signal })
        if (observed) {
          options.signal?.throwIfAborted()
          await handle.chmod(observed.mode & 0o7777)
        }
      } finally {
        await handle.close()
      }
      options.signal?.throwIfAborted()
      if (observed) {
        const latest = await this.snapshot(canonical, options)
        if (latest.version !== observed.version) throw new Error('file version conflict')
        options.signal?.throwIfAborted()
        await rename(staging, canonical)
      } else {
        options.signal?.throwIfAborted()
        await link(staging, canonical)
        await unlink(staging)
      }
      staging = undefined
      const result = await this.snapshot(canonical, {})
      return { path: canonical, version: result.version }
    } finally {
      try {
        if (staging)
          await unlink(staging).catch((error: unknown) => {
            if (!missing(error)) throw error
          })
      } finally {
        turn.resolve()
        if (this.pending.get(canonical) === turn.promise) this.pending.delete(canonical)
      }
    }
  }
}

export function localFileSystemPlugin(ctx: Context, config: LocalFileSystemConfig = {}): void {
  new LocalFileSystemService(ctx, config)
}

export default localFileSystemPlugin
