import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/contracts/composer.ts'
import type {} from '@keundal/ui-runtime'
import type { CodingWorkspaceSnapshot } from '@keundal/workspace'
import Workspace from './views/Workspace.vue'

export const name = 'ui-workspace'
export const inject = ['slots', 'chatRuntime']

export const metadata = {
  name: { en: 'Coding workspace view', ko: '코딩 작업공간 화면' },
  description: {
    en: 'Selects coding projects and provides diff review and application controls.',
    ko: '코딩 프로젝트를 선택하고 변경 사항을 검토·적용합니다.'
  }
}

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
