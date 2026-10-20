import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { Context } from 'cordis'

import { FileReferenceService, type FileReferenceCandidate } from './file-reference.js'

export const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20
export const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 50_000
export const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle'
] as const

export interface LocalFileReferenceConfig {
  /** Workspace root used by the local path provider. */
  root: string
  maxResults?: number
  maxEntries?: number
  excludedDirectories?: readonly string[]
}

/** Local-workspace provider returning deterministic path-only completions. */
export class LocalFileReferenceService extends FileReferenceService {
  private readonly root: string
  private readonly maxResults: number
  private readonly maxEntries: number
  private readonly excluded: ReadonlySet<string>
  private indexed: FileReferenceCandidate[] | undefined
  private scanPromise: Promise<FileReferenceCandidate[]> | undefined

  constructor(ctx: Context, config: LocalFileReferenceConfig) {
    super(ctx)
    if (config.root.length === 0) throw new TypeError('local file reference root is required')
    this.root = resolve(config.root)
    this.maxResults = config.maxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS
    this.maxEntries = config.maxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES
    const excluded = config.excludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES
    if (
      !Number.isSafeInteger(this.maxResults) ||
      this.maxResults < 1 ||
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      excluded.some((name) => name.length === 0 || name.includes('/') || name.includes('\\'))
    ) {
      throw new TypeError('invalid local file reference configuration')
    }
    this.excluded = new Set(excluded)
  }

  override async list(query: string, signal?: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal?.throwIfAborted()
    const normalized = query.replaceAll('\\', '/')
    const slash = normalized.lastIndexOf('/')
    if (slash >= 0) return this.listDirectory(normalized.slice(0, slash + 1), normalized.slice(slash + 1), signal)
    const entries = await this.index(signal)
    signal?.throwIfAborted()
    const candidates = entries.filter((item) => {
      const basename = item.path.slice(item.path.lastIndexOf('/') + 1)
      if (basename.startsWith('.') && !normalized.startsWith('.')) return false
      return fuzzyMatch(item.path, normalized)
    })
    candidates.sort((a, b) => compareRank(a, b, normalized))
    return candidates.slice(0, this.maxResults)
  }

  /** Discard the recursive index after workspace file changes. */
  invalidate(): void {
    this.indexed = undefined
  }

  private async index(signal?: AbortSignal): Promise<FileReferenceCandidate[]> {
    if (this.indexed) return this.indexed
    if (!this.scanPromise) {
      this.scanPromise = this.scan(signal)
        .then((entries) => {
          this.indexed = entries
          return entries
        })
        .finally(() => {
          this.scanPromise = undefined
        })
    }
    return this.scanPromise
  }

  private async scan(signal?: AbortSignal): Promise<FileReferenceCandidate[]> {
    const results: FileReferenceCandidate[] = []
    const queue: { absolute: string; path: string }[] = [{ absolute: this.root, path: '' }]
    while (queue.length > 0 && results.length < this.maxEntries) {
      signal?.throwIfAborted()
      const current = queue.shift()
      if (!current) break
      let entries
      try {
        entries = await readdir(current.absolute, { withFileTypes: true })
      } catch {
        signal?.throwIfAborted()
        if (current.path === '') throw new Error(`cannot read workspace root: ${this.root}`)
        continue
      }
      signal?.throwIfAborted()
      entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
      for (const entry of entries) {
        signal?.throwIfAborted()
        if (entry.isDirectory() && this.excluded.has(entry.name)) continue
        const path = current.path ? `${current.path}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          results.push({ path, kind: 'directory' })
          queue.push({ absolute: join(current.absolute, entry.name), path })
        } else if (entry.isFile()) results.push({ path, kind: 'file' })
        if (results.length >= this.maxEntries) break
      }
    }
    return results
  }

  private async listDirectory(
    directory: string,
    fragment: string,
    signal?: AbortSignal
  ): Promise<FileReferenceCandidate[]> {
    if (directory.split('/').some((segment) => this.excluded.has(segment))) return []
    const absolute = resolve(this.root, directory || '.')
    const fromRoot = relative(this.root, absolute)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return []
    let current = this.root
    for (const segment of fromRoot.split(sep).filter(Boolean)) {
      signal?.throwIfAborted()
      current = join(current, segment)
      try {
        const status = await lstat(current)
        if (status.isSymbolicLink() || !status.isDirectory()) return []
      } catch {
        signal?.throwIfAborted()
        return []
      }
    }
    signal?.throwIfAborted()
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      signal?.throwIfAborted()
      return []
    }
    signal?.throwIfAborted()
    const candidates: FileReferenceCandidate[] = []
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (!entry.name.toLocaleLowerCase().startsWith(fragment.toLocaleLowerCase())) continue
      if (entry.name.startsWith('.') && !fragment.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (this.excluded.has(entry.name)) continue
        candidates.push({ path: `${directory}${entry.name}`, kind: 'directory' })
      } else if (entry.isFile()) candidates.push({ path: `${directory}${entry.name}`, kind: 'file' })
    }
    candidates.sort((a, b) => compareRank(a, b, fragment))
    return candidates.slice(0, this.maxResults)
  }
}

function fuzzyMatch(path: string, query: string): boolean {
  if (query === '') return true
  const value = path.toLocaleLowerCase()
  const target = query.toLocaleLowerCase()
  if (value.includes(target)) return true
  let cursor = 0
  for (const character of target) {
    cursor = value.indexOf(character, cursor)
    if (cursor < 0) return false
    cursor += 1
  }
  return true
}

function compareRank(a: FileReferenceCandidate, b: FileReferenceCandidate, query: string): number {
  const normalized = query.toLocaleLowerCase()
  const score = (item: FileReferenceCandidate) => {
    const path = item.path.toLocaleLowerCase()
    return path === normalized ? 0 : path.startsWith(normalized) ? 1 : path.includes(normalized) ? 2 : 3
  }
  return (
    score(a) - score(b) ||
    (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) ||
    a.path.localeCompare(b.path, 'en')
  )
}

export function localFileReferencePlugin(ctx: Context, config: LocalFileReferenceConfig): void {
  new LocalFileReferenceService(ctx, config)
}

export default localFileReferencePlugin
