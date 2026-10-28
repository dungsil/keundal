import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import type { ExecutionOptions } from '@keundal/core'
import {
  WorkspaceService,
  type TaskWorktree,
  type WorkspaceChange,
  type WorkspaceDiffOptions,
  type WorkspaceOptions,
  type WorkspaceReviewer
} from '@keundal/workspace'
import type { Context } from 'cordis'

export interface GitWorkspaceConfig {
  readonly cwd: string
  /** 기본 저장소 밖에 있는 전용 디렉터리여야 합니다. */
  readonly worktreeRoot: string
  /** 생략하면 조회만 허용합니다. */
  readonly review?: WorkspaceReviewer
}

function within(root: string, path: string): boolean {
  const delta = relative(root, path)
  return !isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`)
}

function taskName(taskId: string): void {
  if (typeof taskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(taskId)) {
    throw new TypeError('taskId must contain 1-64 ASCII letters, digits, underscores or hyphens')
  }
}

export class GitWorkspaceService extends WorkspaceService {
  private readonly cwd: string
  private readonly worktreeRoot: string
  private readonly review: WorkspaceReviewer | undefined
  private readonly tasks = new Map<string, { path: string; head: string; base?: string }>()
  private readonly lifetime = new globalThis.AbortController()
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: GitWorkspaceConfig) {
    super(ctx)
    this.cwd = realpathSync(config.cwd)
    this.worktreeRoot = resolve(config.worktreeRoot)
    if (within(this.cwd, this.worktreeRoot)) throw new Error('worktreeRoot must be outside the repository')
    this.review = config.review
    ctx.fiber.effect(() => async () => {
      this.lifetime.abort(new Error('Git workspace disposed'))
      await this.mutations.catch(() => {})
    })
  }

  private options(options: ExecutionOptions): ExecutionOptions {
    const signal = options.signal
      ? globalThis.AbortSignal.any([options.signal, this.lifetime.signal])
      : this.lifetime.signal
    signal.throwIfAborted()
    return { signal }
  }

  private async git(
    cwd: string,
    args: readonly string[],
    options: ExecutionOptions,
    input?: string | Buffer,
    indexPath?: string
  ): Promise<string> {
    options.signal?.throwIfAborted()
    const overrides: string[] = []
    if (args[0] === 'worktree' && args[1] === 'add') {
      // Checkout must not execute repository-selected clean/smudge/process programs.
      const keys = (await this.git(cwd, ['config', '--null', '--name-only', '--list'], options)).split('\0')
      for (const key of keys.filter((key) => /^filter\..*\.(clean|smudge|process|required)$/i.test(key))) {
        overrides.push('-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`)
      }
    }
    return new Promise((accept, reject) => {
      const child = execFile(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.quotePath=true',
          ...overrides,
          ...args
        ],
        {
          cwd,
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
            GIT_TERMINAL_PROMPT: '0',
            ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {})
          },
          signal: options.signal,
          timeout: 30000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`Git ${args[0]} failed: ${stderr || error.message}`, { cause: error }))
          else accept(stdout)
        }
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
  }

  private async directory(options: WorkspaceOptions): Promise<string> {
    if (options.taskId !== undefined && !this.tasks.has(options.taskId)) {
      taskName(options.taskId)
      const data = await readFile(join(this.worktreeRoot, `${options.taskId}.json`), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') throw new Error('unknown task Worktree')
          throw error
        }
      )
      const record: unknown = JSON.parse(data)
      if (
        !record ||
        typeof record !== 'object' ||
        !('head' in record) ||
        typeof record.head !== 'string' ||
        !/^[a-f0-9]{40,64}$/.test(record.head)
      ) {
        throw new Error('invalid task Worktree record')
      }
      const base = 'base' in record ? record.base : undefined
      if (base !== undefined && (typeof base !== 'string' || !/^[a-f0-9]{40,64}$/.test(base)))
        throw new Error('invalid task base')
      this.tasks.set(options.taskId, { path: join(this.worktreeRoot, options.taskId), head: record.head, base })
    }
    const path = options.taskId === undefined ? this.cwd : this.tasks.get(options.taskId)?.path
    if (!path) throw new Error('unknown task Worktree')
    const canonical = await realpath(path)
    if (canonical !== path) throw new Error('workspace path changed')
    const root = (await this.git(path, ['rev-parse', '--show-toplevel'], options)).trim()
    if ((await realpath(root)) !== path) throw new Error('cwd must be a Git working tree root')
    if (options.taskId !== undefined) {
      const common = async (cwd: string) =>
        realpath(resolve(cwd, (await this.git(cwd, ['rev-parse', '--git-common-dir'], options)).trim()))
      if ((await common(path)) !== (await common(this.cwd))) throw new Error('task belongs to another repository')
    }
    return path
  }

  /** Complete base-to-files snapshot, including task commits and untracked files, without touching the real index or running filters. */
  async fullSnapshot(
    options: WorkspaceOptions = {}
  ): Promise<{ path: string; patch: string; changes: readonly WorkspaceChange[]; fingerprint: string; tree: string }> {
    options = { ...options, ...this.options(options) }
    const path = await this.directory(options)
    const head = (await this.git(path, ['rev-parse', 'HEAD'], options)).trim()
    const task = options.taskId ? this.tasks.get(options.taskId)! : undefined
    const base = task ? (task.base ?? task.head) : head
    const scratch = await mkdtemp(join(tmpdir(), 'keundal-git-index-'))
    const index = join(scratch, 'index')
    try {
      await this.git(path, ['read-tree', '--empty'], options, undefined, index)
      const files = [
        ...new Set(
          (await this.git(path, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], options))
            .split('\0')
            .filter(Boolean)
        )
      ]
      if (files.length > 10000) throw new Error('workspace exceeds snapshot file limit')
      const entries: string[] = []
      let bytes = 0
      for (const file of files) {
        options.signal?.throwIfAborted()
        const target = resolve(path, file)
        if (!within(path, target) || target === path || file.toLowerCase().split(/[\\/]/).includes('.git'))
          throw new Error('unsafe workspace path')
        let parent = dirname(target)
        while (parent !== path) {
          if ((await lstat(parent).catch(() => undefined))?.isSymbolicLink())
            throw new Error('workspace ancestors must not be symlinks')
          parent = dirname(parent)
        }
        const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (!info) continue
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error('submodules and special files are not supported')
        bytes += info.size
        if (bytes > 32 * 1024 * 1024) throw new Error('workspace exceeds snapshot byte limit')
        const data = info.isSymbolicLink() ? await readlink(target) : await readFile(target, { signal: options.signal })
        const hash = (await this.git(path, ['hash-object', '-w', '--no-filters', '--stdin'], options, data)).trim()
        const mode = info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644'
        entries.push(`${mode} ${hash}\t${file}\0`)
      }
      await this.git(path, ['update-index', '-z', '--index-info'], options, entries.join(''), index)
      const tree = (await this.git(path, ['write-tree'], options, undefined, index)).trim()
      const patch = await this.git(
        path,
        ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', base, tree, '--'],
        options
      )
      const names = (
        await this.git(
          path,
          ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, tree, '--'],
          options
        )
      ).split('\0')
      const changes: WorkspaceChange[] = []
      for (let i = 0; i + 1 < names.length; i += 2)
        changes.push({ path: names[i + 1]!, index: names[i]!, workingTree: ' ' })
      return {
        path,
        patch,
        changes,
        tree,
        fingerprint: createHash('sha256').update(`${head}:${base}:${tree}`).digest('hex')
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** Advance only the reviewed base, retaining edits made after the reviewed snapshot. */
  checkpointTask(taskId: string, tree: string, options: ExecutionOptions = {}): Promise<void> {
    return this.mutate(options, async (guarded) => {
      await this.directory({ ...guarded, taskId })
      if (
        !/^[a-f0-9]{40,64}$/.test(tree) ||
        (await this.git(this.cwd, ['cat-file', '-t', tree], guarded)).trim() !== 'tree'
      )
        throw new Error('invalid task checkpoint')
      const task = this.tasks.get(taskId)!
      const record = join(this.worktreeRoot, `${taskId}.json`)
      // Retain every persisted base across Git GC, including a crash between ref and metadata writes.
      await this.git(this.cwd, ['update-ref', `refs/keundal-workspaces/${taskId}/base-${tree}`, tree], guarded)
      await writeFile(`${record}.tmp`, JSON.stringify({ head: task.head, base: tree }), { mode: 0o600 })
      await rename(`${record}.tmp`, record)
      task.base = tree
    })
  }

  async status(options: WorkspaceOptions = {}) {
    options = { ...options, ...this.options(options) }
    const path = await this.directory(options)
    const output = await this.git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options)
    const records = output.split('\0')
    const changes: WorkspaceChange[] = []
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!
      if (!record) continue
      const index = record[0]!
      const workingTree = record[1]!
      const previousPath = /[RC]/.test(index + workingTree) ? records[++i] : undefined
      changes.push({ path: record.slice(3), index, workingTree, ...(previousPath ? { previousPath } : {}) })
    }
    const head = await this.git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], options).catch(() => {
      // 빈 저장소는 HEAD 커밋 없이 브랜치 이름만 가집니다.
      return this.git(path, ['symbolic-ref', '--short', 'HEAD'], options)
    })
    return { path, branch: head.trim() === 'HEAD' ? null : head.trim(), changes }
  }

  async diff(options: WorkspaceDiffOptions = {}): Promise<string> {
    options = { ...options, ...this.options(options) }
    return this.git(
      await this.directory(options),
      ['diff', '--no-ext-diff', '--no-textconv', '--binary', ...(options.staged ? ['--cached'] : []), '--'],
      options
    )
  }

  private mutate<T>(options: ExecutionOptions, run: (options: ExecutionOptions) => Promise<T>): Promise<T> {
    const guarded = this.options(options)
    const pending = this.mutations.then(() => {
      guarded.signal?.throwIfAborted()
      return run(guarded)
    })
    this.mutations = pending.catch(() => {})
    return pending
  }

  private async approve(review: Parameters<WorkspaceReviewer>[0], options: ExecutionOptions): Promise<void> {
    if (!this.review) throw new Error('workspace mutation was not approved')
    const reviewer = this.review
    const approved = await new Promise<boolean>((accept, reject) => {
      const abort = () => reject(options.signal?.reason)
      options.signal?.addEventListener('abort', abort, { once: true })
      Promise.resolve()
        .then(() => {
          options.signal?.throwIfAborted()
          return reviewer(Object.freeze(review), options)
        })
        .then(accept, reject)
        .finally(() => options.signal?.removeEventListener('abort', abort))
    })
    if (approved !== true) throw new Error('workspace mutation was not approved')
    options.signal?.throwIfAborted()
  }

  private async snapshot(path: string, files: readonly string[], options: ExecutionOptions): Promise<string> {
    const hash = createHash('sha256')
    for (const file of files) {
      const target = resolve(path, file)
      if (!within(path, target) || target === path || file.toLowerCase().split(/[\\/]/).includes('.git')) {
        throw new Error('unsafe patch path')
      }
      // 읽기 전에 조상과 대상의 링크를 거부합니다. Git 메타데이터도 패치하지 않습니다.
      let parent = target
      while (parent !== path) {
        const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (info?.isSymbolicLink()) throw new Error('patch paths must not contain symlinks')
        parent = dirname(parent)
      }
      const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      hash
        .update(file)
        .update('\0')
        .update(info ? `${info.mode}:` : 'missing:')
      if (info?.isFile())
        hash.update(
          createHash('sha256')
            .update(await readFile(target, { signal: options.signal }))
            .digest()
        )
    }
    return hash.digest('hex')
  }

  applyPatch(patch: string, options: WorkspaceOptions = {}): Promise<void> {
    return this.mutate(options, async (guarded) => {
      if (typeof patch !== 'string' || !patch.trim() || Buffer.byteLength(patch) > 8 * 1024 * 1024) {
        throw new TypeError('patch must contain at most 8 MiB of nonempty Git patch text')
      }
      const path = await this.directory({ ...options, ...guarded })
      await this.git(path, ['apply', '--check', '--whitespace=nowarn', '-'], guarded, patch)
      const numstat = await this.git(path, ['apply', '--numstat', '-z', '-'], guarded, patch)
      const reverse = await this.git(path, ['apply', '--numstat', '-z', '--reverse', '-'], guarded, patch)
      // NUL 구분을 유지하여 공백, 탭, 줄바꿈이 있는 파일 이름도 보존합니다.
      // 역방향 출력도 읽어 이름 변경·복사의 원본과 대상 모두를 검사합니다.
      const files = [
        ...new Set(
          (numstat + reverse)
            .split('\0')
            .filter(Boolean)
            .map((record) => record.slice(record.indexOf('\t', record.indexOf('\t') + 1) + 1))
        )
      ]
      const modes = await this.git(path, ['apply', '--summary', '-'], guarded, patch)
      if (/^ (?:create mode (?:120000|160000) |mode change \d+ => (?:120000|160000) )/m.test(modes)) {
        throw new Error('symlink and submodule patches are not supported')
      }
      const before = await this.snapshot(path, files, guarded)
      const summary = await this.git(path, ['apply', '--stat', '-'], guarded, patch)
      await this.approve({ operation: 'apply', path, patch, summary }, guarded)
      await this.directory({ ...options, ...guarded })
      if ((await this.snapshot(path, files, guarded)) !== before) throw new Error('workspace changed during review')
      await this.git(path, ['apply', '--check', '--whitespace=nowarn', '-'], guarded, patch)
      await this.git(path, ['apply', '--whitespace=nowarn', '-'], guarded, patch)
    })
  }

  createWorktree(taskId: string, options: ExecutionOptions = {}): Promise<TaskWorktree> {
    return this.mutate(options, async (guarded) => {
      taskName(taskId)
      await this.directory(guarded)
      if (this.tasks.has(taskId)) throw new Error('task Worktree already exists')
      const head = (await this.git(this.cwd, ['rev-parse', '--verify', 'HEAD'], guarded)).trim()
      const path = join(this.worktreeRoot, taskId)
      await this.approve({ operation: 'createWorktree', taskId, path, head }, guarded)
      await mkdir(this.worktreeRoot, { recursive: true })
      const root = await realpath(this.worktreeRoot)
      if (root !== this.worktreeRoot || within(this.cwd, root))
        throw new Error('worktreeRoot must be a canonical path outside the repository')
      await this.directory(guarded)
      await this.git(this.cwd, ['worktree', 'add', '--detach', '--', path, head], guarded)
      this.tasks.set(taskId, { path, head })
      await this.git(this.cwd, ['update-ref', `refs/keundal-workspaces/${taskId}/initial`, head], guarded)
      await writeFile(join(this.worktreeRoot, `${taskId}.json`), JSON.stringify({ head }), { flag: 'wx', mode: 0o600 })
      return { taskId, path }
    })
  }

  removeWorktree(taskId: string, options: ExecutionOptions = {}): Promise<void> {
    return this.mutate(options, async (guarded) => {
      taskName(taskId)
      const path = await this.directory({ ...guarded, taskId })
      const head = this.tasks.get(taskId)!.head
      await this.approve({ operation: 'removeWorktree', taskId, path, head }, guarded)
      await this.directory({ ...guarded, taskId })
      const changes = await this.git(
        path,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'],
        guarded
      )
      if (changes) throw new Error('task Worktree contains changed, untracked or ignored files')
      if ((await this.git(path, ['rev-parse', 'HEAD'], guarded)).trim() !== head) {
        throw new Error('task Worktree HEAD changed; preserve its commits before removing it')
      }
      // Git도 변경 파일과 잠긴 Worktree를 다시 검사합니다. --force는 사용하지 않습니다.
      await this.git(this.cwd, ['worktree', 'remove', '--', path], guarded)
      this.tasks.delete(taskId)
      await rm(join(this.worktreeRoot, `${taskId}.json`), { force: true })
      const refs = (
        await this.git(this.cwd, ['for-each-ref', '--format=%(refname)', `refs/keundal-workspaces/${taskId}/`], guarded)
      )
        .split('\n')
        .filter(Boolean)
      if (refs.length)
        await this.git(this.cwd, ['update-ref', '--stdin'], guarded, refs.map((ref) => `delete ${ref}\n`).join(''))
    })
  }
}

export function gitWorkspacePlugin(ctx: Context, config: GitWorkspaceConfig): void {
  new GitWorkspaceService(ctx, config)
}

export default gitWorkspacePlugin
