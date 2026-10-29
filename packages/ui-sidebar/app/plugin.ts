import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/contracts/layout.ts'
import AppSidebar from './views/AppSidebar.vue'

export const name = 'ui-sidebar'
export const inject = ['slots']

export function apply(ctx: Context) {
  ctx.slots.inject('layout.navigation', () => ctx.slots.register({
    name: 'layout.navigation',
    children: {
      'layout.sidebar': 'list',
      'layout.sidebar.footer': 'list'
    }
  }, AppSidebar))
}
