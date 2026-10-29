import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/contracts/layout.ts'
import type {} from '@keundal/ui-runtime'
import AppShell from './views/AppShell.vue'

export const name = 'ui-shell'
export const inject = ['slots', 'chatRuntime']

export function apply(ctx: Context) {
  ctx.slots.register({
    name: 'root',
    children: { 'app.layout': 'single' },
    inject: () => ({ ready: ctx.chatRuntime.ready })
  }, AppShell)
}
