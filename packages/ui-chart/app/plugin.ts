import type {} from '@keundal/ui-chat/slots'
import { lazyView } from '@keundal/ui-slots'
import type { Context } from 'cordis'

export const name = 'ui-chart'
export const inject = ['slots']

const Chart = lazyView(() => import('./views/Chart.vue'), ['part'])

export function apply(ctx: Context) {
  ctx.slots.inject('chat.message.tool', () =>
    ctx.slots.register({ name: 'chat.message.tool', key: 'chart' }, Chart)
  )
}
