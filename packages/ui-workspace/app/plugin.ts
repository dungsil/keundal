import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/contracts/composer.ts'
import type {} from '@keundal/ui-runtime'
import type { CodingWorkspaceSnapshot } from '@keundal/workspace'
import Workspace from './views/Workspace.vue'

export const name = 'ui-workspace'
export const inject = ['slots', 'chatRuntime']

export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('composer.actions', () => ctx.slots.register({
    name: 'composer.actions',
    id: 'workspace',
    order: 5,
    inject: () => ({
      available: runtime.workspacesAvailable,
      getWorkspace: (id: string) => runtime.workspaces.get(id),
      createWorkspace: (id: string, path: string) => runtime.workspaces.create(id, path),
      reviewWorkspace: (id: string) => runtime.workspaces.review(id),
      applyWorkspace: (id: string, reviewId: string): Promise<CodingWorkspaceSnapshot> => runtime.workspaces.apply(id, reviewId)
    })
  }, Workspace))
}
