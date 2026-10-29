import type { Context } from 'cordis'
import type { SubagentRole } from '@keundal/subagent'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui/app/contracts/settings.ts'
import { lazyView } from '@keundal/ui-slots'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'

import { messages } from './locale'

const SubagentSettings = lazyView(() => import('./views/SubagentSettings.vue'), ['subagentRoles', 'saveSubagentRoles', 'models'])
const BackgroundTasks = lazyView(() => import('./views/BackgroundTasks.vue'), ['listTasks', 'cancelTask'])

export const name = 'ui-subagents'
export const inject = ['slots', 'chatRuntime']

/** Add subagent roles to the settings page. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'subagents',
    order: 30,
    meta: { label: localizedText(messages, 'subagents.title'), icon: 'i-lucide-users', group: 'general' },
    inject: () => ({
      subagentRoles: runtime.subagentRoles,
      models: runtime.models,
      saveSubagentRoles: (value: readonly SubagentRole[]) => runtime.saveSubagentRoles(value)
    })
  }, SubagentSettings))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'tasks',
    order: 31,
    meta: { label: localizedText(messages, 'tasks.title'), icon: 'i-lucide-list-todo', group: 'general' },
    inject: () => ({
      listTasks: () => runtime.listBackgroundTasks(),
      cancelTask: (id: string) => runtime.cancelBackgroundTask(id)
    })
  }, BackgroundTasks))
}
