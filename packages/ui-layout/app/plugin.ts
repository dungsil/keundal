import type { Context } from 'cordis'
import type {} from '@keundal/ui-slots'

import type {} from './slots'
import AppFrame from './views/AppFrame.vue'

export const name = 'ui-layout'
export const inject = ['slots']

/** Render the application frame at `root` and declare the page and sidebar slots inside it. */
export function apply(ctx: Context) {
  ctx.slots.register({
    name: 'root',
    children: {
      'page.home': 'single',
      'page.chat': 'single',
      'page.history': 'single',
      'page.settings': 'single',
      'layout.sidebar': 'list',
      'layout.sidebar.footer': 'list',
      'layout.overlay': 'list'
    }
  }, AppFrame)
}
