import type { Context } from 'cordis'
import type { RunBudget } from '@keundal/agent'
import type {} from '@keundal/ui-layout/slots'
import type {} from '@keundal/ui-runtime'
import { lazyView } from '@keundal/ui-slots'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'

import { messages } from './locale'
import type {} from './slots'
import AppearanceSection from './views/AppearanceSection.vue'
import SettingsLink from './views/SettingsLink.vue'
import SettingsPage from './views/SettingsPage.vue'

export const name = 'ui-settings'
export const inject = ['slots', 'chatRuntime']

const ExecutionBudgetSettings = lazyView(() => import('./views/ExecutionBudgetSettings.vue'), ['runBudget', 'saveRunBudget'])

/** Render the settings page with its section navigation, the appearance section and the sidebar link. */
export function apply(ctx: Context) {
  ctx.slots.inject('page.settings', () => ctx.slots.register({
    name: 'page.settings',
    children: { 'settings.section': 'keyed' }
  }, SettingsPage))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'appearance',
    order: 0,
    meta: { label: localizedText(messages, 'settings.appearance'), icon: 'i-lucide-palette', group: 'general' }
  }, AppearanceSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'execution',
    order: 25,
    meta: { label: localizedText(messages, 'budget.title'), icon: 'i-lucide-gauge', group: 'general' },
    inject: () => ({
      runBudget: ctx.chatRuntime.runBudget,
      saveRunBudget: (value: RunBudget | undefined) => ctx.chatRuntime.saveRunBudget(value)
    })
  }, ExecutionBudgetSettings))
  ctx.slots.inject('layout.sidebar.footer', () => ctx.slots.register({
    name: 'layout.sidebar.footer',
    id: 'settings',
    order: 0
  }, SettingsLink))
}
