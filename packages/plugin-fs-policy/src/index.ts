import {
  FileSystemService,
  type ExecutionOptions,
  type FileEdit,
  type FileMutation,
  type FileMutationOptions,
  type FileSystemOptions
} from '@keundal/core'
import type { Context } from 'cordis'

export interface FileSystemPolicyConfig {
  readonly backend: FileSystemService
  readonly roots: readonly string[]
  /** 생략하면 모든 수정을 거부합니다. */
  readonly writableRoots?: readonly string[]
  readonly maxScopes?: number
  readonly maxFilesPerScope?: number
}

export class PolicyFileSystemService extends FileSystemService {
  private readonly backend: FileSystemService
  private readonly roots: readonly string[]
  private readonly writableRoots: readonly string[]
  private readonly maxScopes: number
  private readonly maxFilesPerScope: number
  private readonly observations = new Map<string, Map<string, string>>()
  private readonly lifetime = new globalThis.AbortController()
  private closed = false

  constructor(ctx: Context, config: FileSystemPolicyConfig) {
    super(ctx)
    if (!config.backend || !config.roots.length) throw new Error('backend and roots are required')
    this.backend = config.backend
    this.roots = [...config.roots]
    this.writableRoots = [...(config.writableRoots ?? [])]
    this.maxScopes = config.maxScopes ?? 128
    this.maxFilesPerScope = config.maxFilesPerScope ?? 1024
    for (const value of [this.maxScopes, this.maxFilesPerScope]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('observation limits must be positive integers')
    }
    ctx.fiber.effect(() => () => {
      this.closed = true
      this.lifetime.abort(new Error('file system policy disposed'))
      this.observations.clear()
    })
  }

  private check(options: ExecutionOptions) {
    if (this.closed) throw new Error('file system policy disposed')
    options.signal?.throwIfAborted()
  }

  private withLifetime<T extends ExecutionOptions>(options: T): T {
    return {
      ...options,
      signal: options.signal ? globalThis.AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal
    }
  }

  private async allowed(path: string, roots: readonly string[], options: ExecutionOptions): Promise<boolean> {
    for (const root of roots) {
      const canonicalRoot = await this.backend.resolve(root, options)
      if (this.backend.contains(canonicalRoot, path)) return true
    }
    return false
  }

  async resolve(path: string, options: ExecutionOptions = {}): Promise<string> {
    options = this.withLifetime(options)
    this.check(options)
    const canonical = await this.backend.resolve(path, options)
    if (!(await this.allowed(canonical, this.roots, options))) throw new Error('path is outside allowed roots')
    this.check(options)
    return canonical
  }

  contains(root: string, path: string): boolean {
    return this.backend.contains(root, path)
  }

  private remember(scope: string | undefined, path: string, version: string) {
    if (!scope || this.closed) return
    let files = this.observations.get(scope)
    if (!files) {
      if (this.observations.size >= this.maxScopes) this.observations.delete(this.observations.keys().next().value!)
      files = new Map()
      this.observations.set(scope, files)
    }
    files.delete(path)
    if (files.size >= this.maxFilesPerScope) files.delete(files.keys().next().value!)
    files.set(path, version)
  }

  /** 호출이 끝난 scope의 읽기 기록을 지웁니다. */
  forget(scope: string): void {
    this.observations.delete(scope)
  }

  async read(path: string, options: FileSystemOptions = {}) {
    options = this.withLifetime(options)
    const canonical = await this.resolve(path, options)
    const result = await this.backend.read(canonical, options)
    this.check(options)
    this.remember(options.scope, canonical, result.version)
    return result
  }

  async list(path: string, options: FileSystemOptions = {}) {
    options = this.withLifetime(options)
    return this.backend.list(await this.resolve(path, options), options)
  }

  write(path: string, content: string, options: FileMutationOptions = {}): Promise<FileMutation> {
    return this.mutate(path, options, false, (canonical, guarded) => this.backend.write(canonical, content, guarded))
  }

  edit(path: string, edit: FileEdit, options: FileMutationOptions = {}): Promise<FileMutation> {
    return this.mutate(path, options, true, (canonical, guarded) => this.backend.edit(canonical, edit, guarded))
  }

  private async mutate(
    path: string,
    options: FileMutationOptions,
    editing: boolean,
    apply: (canonical: string, guarded: FileMutationOptions) => Promise<FileMutation>
  ): Promise<FileMutation> {
    options = this.withLifetime(options)
    const canonical = await this.resolve(path, options)
    if (!(await this.allowed(canonical, this.writableRoots, options))) throw new Error('path is read-only')
    if (!options.scope?.trim()) throw new Error('scope is required for mutations')
    const observed = this.observations.get(options.scope)?.get(canonical)
    if (editing && observed === undefined) throw new Error('read the file before editing')
    const expectedVersion = observed ?? null
    if (options.expectedVersion !== undefined && options.expectedVersion !== expectedVersion)
      throw new Error('expectedVersion does not match the observed version')
    this.check(options)
    const result = await apply(canonical, { ...options, expectedVersion })
    this.remember(options.scope, canonical, result.version)
    return result
  }
}

export function fileSystemPolicyPlugin(ctx: Context, config: FileSystemPolicyConfig): void {
  new PolicyFileSystemService(ctx, config)
}

export default fileSystemPolicyPlugin
