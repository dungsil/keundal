import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/types/markdown.ts'
import { lazyView } from '@keundal/ui-slots'

export const name = 'ui-markdown-comark'
export const inject = ['slots']

const Comark = lazyView(() => import('./views/Comark'), ['value', 'streaming', 'sources'])

export function apply(ctx: Context) {
  ctx.slots.registerFactory({ name: 'markdown' }, Comark)
}
