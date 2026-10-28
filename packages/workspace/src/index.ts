import type { ExecutionOptions } from '@keundal/core'
import { Service, type Context } from 'cordis'

export interface WorkspaceOptions extends ExecutionOptions {
  /** 생략하면 기본 저장소, 지정하면 해당 작업의 Worktree를 사용합니다. */
  readonly taskId?: string
}

export interface WorkspaceChange {
  readonly path: string
  readonly previousPath?: string
  readonly index: string
  readonly workingTree: string
}

export interface CodingWorkspaceSnapshot {
  readonly threadId: string
  readonly projectPath: string
  readonly path: string
  readonly changes: readonly WorkspaceChange[]
  readonly patch: string
  readonly reviewId?: string
}

/** User-facing capability. Never expose creation or apply as model tools. */
export interface CodingWorkspaceClient {
  get(threadId: string): Promise<CodingWorkspaceSnapshot | undefined>
  create(threadId: string, projectPath: string): Promise<CodingWorkspaceSnapshot>
  review(threadId: string): Promise<CodingWorkspaceSnapshot>
  apply(threadId: string, reviewId: string): Promise<CodingWorkspaceSnapshot>
}

export interface WorkspaceStatus {
  readonly path: string
  readonly branch: string | null
  readonly changes: readonly WorkspaceChange[]
}

export interface WorkspaceDiffOptions extends WorkspaceOptions {
  readonly staged?: boolean
}

export interface TaskWorktree {
  readonly taskId: string
  readonly path: string
}

/** 앱이 사용자 검토나 승인 정책에 연결합니다. 모델의 인자로 승인을 받지 않습니다. */
export type WorkspaceReview =
  | { readonly operation: 'apply'; readonly path: string; readonly patch: string; readonly summary: string }
  | {
      readonly operation: 'createWorktree' | 'removeWorktree'
      readonly taskId: string
      readonly path: string
      readonly head: string
    }

export type WorkspaceReviewer = (review: WorkspaceReview, options: ExecutionOptions) => Promise<boolean>

declare module 'cordis' {
  interface Context {
    readonly workspace: WorkspaceService
  }
}

export abstract class WorkspaceService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workspace')
  }

  abstract status(options?: WorkspaceOptions): Promise<WorkspaceStatus>
  /** 기본값은 unstaged Diff입니다. 새 파일은 status()의 ?? 항목으로 확인합니다. */
  abstract diff(options?: WorkspaceDiffOptions): Promise<string>
  /** 검토 시점 이후 대상 내용이 달라지면 적용하지 않습니다. index는 바꾸지 않습니다. */
  abstract applyPatch(patch: string, options?: WorkspaceOptions): Promise<void>
  /** 현재 HEAD에서 detached Worktree를 만듭니다. 기본 저장소의 미커밋 변경은 복사하지 않습니다. */
  abstract createWorktree(taskId: string, options?: ExecutionOptions): Promise<TaskWorktree>
  /** 변경·새 파일·작업에서 만든 커밋이 있으면 거부합니다. 강제 삭제는 제공하지 않습니다. */
  abstract removeWorktree(taskId: string, options?: ExecutionOptions): Promise<void>
}
