import type { Context } from 'cordis'
import type {} from '@keundal/ui-slots'

import type {} from '@keundal/ui/app/contracts/layout.ts'
import AppFrame from './views/AppFrame.vue'

export const name = 'ui-layout'
export const inject = ['slots']

/** Render the page frame and declare navigation, page and overlay slots. */
export function apply(ctx: Context) {
  ctx.slots.inject('app.layout', () => ctx.slots.register({
    name: 'app.layout',
    children: {
      'page.home': 'single',
      'page.chat': 'single',
      'page.history': 'single',
      'page.settings': 'single',
      'layout.navigation': 'single',
      'layout.overlay': 'list'
    }
  }, AppFrame))
}
