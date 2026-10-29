import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/contracts/layout.ts'
import type {} from '@keundal/ui-runtime'
import AppShell from './views/AppShell.vue'

export const name = 'ui-shell'
export const inject = ['slots', 'chatRuntime']

export function apply(ctx: Context) {
  ctx.slots.register({
    name: 'root',
    children: {
      'page.home': 'single',
      'page.chat': 'single',
      'page.history': 'single',
      'page.settings': 'single',
      'layout.navigation': 'single',
      'layout.overlay': 'list'
    },
    inject: () => ({ ready: ctx.chatRuntime.ready })
  }, AppShell)
}
