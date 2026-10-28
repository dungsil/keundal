import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { GitWorkspaceService } from '@keundal/plugin-workspace-git'
import type { CodingWorkspaceClient, CodingWorkspaceSnapshot } from '@keundal/workspace'
import type { Context } from 'cordis'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

class CodingWorkspaceError extends Error {
  override name = 'CodingWorkspaceError'
}

interface Binding {
  readonly threadId: string
  readonly projectPath: string
}

interface Review {
  readonly id: string
  readonly patch: string
  readonly task: string
  readonly target: string
  readonly tree: string
}

/** Durable thread bindings, ephemeral single-use approvals, and no model-facing mutation capabilities. */
export class NodeCodingWorkspaces implements CodingWorkspaceClient {
  private ctx?: Context
  private readonly lifetime = new globalThis.AbortController()
  private readonly projects = new Map<string, Promise<GitWorkspaceService>>()
  private readonly reviews = new Map<string, Review>()
  private pending: Promise<unknown> = Promise.resolve()
  private authorization?: { projectPath: string; taskId: string; review: Review }

  constructor(private readonly root: string) {}

  setup(ctx: Context): void {
    this.ctx = ctx
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.pending.catch(() => {})
      this.reviews.clear()
    })
  }

  private operation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      this.lifetime.signal.throwIfAborted()
      try {
        return await run()
      } catch (error) {
        if (error instanceof CodingWorkspaceError) throw error
        throw new CodingWorkspaceError(
          'Workspace operation failed. Select a Git repository root with a commit; ensure it is accessible and review changes again.',
          { cause: error }
        )
      }
    })
    this.pending = result.catch(() => {})
    return result
  }

  private taskId(threadId: string): string {
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 1024)
      throw new CodingWorkspaceError('Invalid conversation ID.')
    return digest(threadId).slice(0, 48)
  }

  private async binding(threadId: string): Promise<Binding | undefined> {
    const file = join(this.root, `${this.taskId(threadId)}.json`)
    const data = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (data === undefined) return undefined
    const value: unknown = JSON.parse(data)
    if (
      !value ||
      typeof value !== 'object' ||
      !('threadId' in value) ||
      value.threadId !== threadId ||
      !('projectPath' in value) ||
      typeof value.projectPath !== 'string'
    )
      throw new CodingWorkspaceError('The saved workspace binding is invalid. Its files have been preserved.')
    return { threadId, projectPath: value.projectPath }
  }

  private async project(projectPath: string): Promise<GitWorkspaceService> {
    if (!this.ctx) throw new Error('workspaces are not initialized')
    let pending = this.projects.get(projectPath)
    if (!pending) {
      const isolated = this.ctx.isolate('workspace')
      pending = (async () => {
        let service!: GitWorkspaceService
        await isolated.plugin((child: Context) => {
          service = new GitWorkspaceService(child, {
            cwd: projectPath,
            worktreeRoot: join(this.root, digest(projectPath)),
            review: async (request) => {
              // Creation can only originate in create(), following an authenticated user request.
              if (request.operation === 'createWorktree') return true
              const authorization = this.authorization
              if (
                request.operation !== 'apply' ||
                !authorization ||
                authorization.projectPath !== projectPath ||
                request.patch !== authorization.review.patch
              )
                return false
              const task = await service.fullSnapshot({ taskId: authorization.taskId, signal: this.lifetime.signal })
              const target = await service.fullSnapshot({ signal: this.lifetime.signal })
              return (
                task.fingerprint === authorization.review.task && target.fingerprint === authorization.review.target
              )
            }
          })
        })
        return service
      })()
      this.projects.set(projectPath, pending)
      void pending.catch(() => this.projects.delete(projectPath))
    }
    return pending
  }

  private async snapshot(binding: Binding): Promise<CodingWorkspaceSnapshot> {
    const workspace = await this.project(binding.projectPath)
    const task = await workspace.fullSnapshot({ taskId: this.taskId(binding.threadId), signal: this.lifetime.signal })
    const review = this.reviews.get(binding.threadId)
    // A GET never issues fresh authorization and does not keep an outdated approval visible.
    const target = review ? await workspace.fullSnapshot({ signal: this.lifetime.signal }) : undefined
    const reviewId = review?.task === task.fingerprint && review.target === target?.fingerprint ? review.id : undefined
    return { ...binding, path: task.path, changes: task.changes, patch: task.patch, ...(reviewId ? { reviewId } : {}) }
  }

  get(threadId: string): Promise<CodingWorkspaceSnapshot | undefined> {
    return this.operation(async () => {
      const binding = await this.binding(threadId)
      return binding ? this.snapshot(binding) : undefined
    })
  }

  create(threadId: string, projectPath: string): Promise<CodingWorkspaceSnapshot> {
    return this.operation(async () => {
      const taskId = this.taskId(threadId)
      const canonical = await realpath(resolve(projectPath))
      const existing = await this.binding(threadId)
      if (existing) {
        if (existing.projectPath !== canonical)
          throw new CodingWorkspaceError(
            'This conversation already belongs to another project. Start a new conversation to select a different project.'
          )
        return this.snapshot(existing)
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const workspace = await this.project(canonical)
      // Recover a worktree created immediately before a process exit; never remove or overwrite it.
      const record = join(this.root, digest(canonical), `${taskId}.json`)
      const persisted = await readFile(record, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (persisted === undefined) {
        await workspace.createWorktree(taskId, { signal: this.lifetime.signal })
        // Compare later edits against checkout bytes, including configured line endings.
        const initial = await workspace.fullSnapshot({ taskId, signal: this.lifetime.signal })
        await workspace.checkpointTask(taskId, initial.tree, { signal: this.lifetime.signal })
      }
      const binding = { threadId, projectPath: canonical }
      await this.snapshot(binding)
      await writeFile(join(this.root, `${taskId}.json`), JSON.stringify(binding), { flag: 'wx', mode: 0o600 })
      return this.snapshot(binding)
    })
  }

  review(threadId: string): Promise<CodingWorkspaceSnapshot> {
    return this.operation(async () => {
      const binding = await this.binding(threadId)
      if (!binding) throw new CodingWorkspaceError('Select a project before reviewing changes.')
      const workspace = await this.project(binding.projectPath)
      const task = await workspace.fullSnapshot({ taskId: this.taskId(threadId), signal: this.lifetime.signal })
      const target = await workspace.fullSnapshot({ signal: this.lifetime.signal })
      const review = {
        id: randomUUID(),
        patch: task.patch,
        task: task.fingerprint,
        target: target.fingerprint,
        tree: task.tree
      }
      this.reviews.set(threadId, review)
      return { ...binding, path: task.path, changes: task.changes, patch: task.patch, reviewId: review.id }
    })
  }

  apply(threadId: string, reviewId: string): Promise<CodingWorkspaceSnapshot> {
    return this.operation(async () => {
      const binding = await this.binding(threadId)
      const review = this.reviews.get(threadId)
      if (!binding || !review || review.id !== reviewId)
        throw new CodingWorkspaceError('This review is missing or expired. Review the changes again before applying.')
      this.reviews.delete(threadId)
      const workspace = await this.project(binding.projectPath)
      const taskId = this.taskId(threadId)
      const task = await workspace.fullSnapshot({ taskId, signal: this.lifetime.signal })
      const target = await workspace.fullSnapshot({ signal: this.lifetime.signal })
      if (task.fingerprint !== review.task || target.fingerprint !== review.target)
        throw new CodingWorkspaceError('The task or original project changed after review. Review the changes again.')
      if (review.patch) {
        this.authorization = { projectPath: binding.projectPath, taskId, review }
        try {
          await workspace.applyPatch(review.patch, { signal: this.lifetime.signal })
        } catch (error) {
          throw new CodingWorkspaceError(
            'Changes could not be applied safely. Resolve conflicts in the original project and review again.',
            { cause: error }
          )
        } finally {
          this.authorization = undefined
        }
        await workspace.checkpointTask(taskId, review.tree, { signal: this.lifetime.signal })
      }
      return this.snapshot(binding)
    })
  }
}
