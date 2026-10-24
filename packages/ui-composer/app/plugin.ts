import type { Context } from 'cordis'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-slots'
import type {} from './slots'
import Composer from './views/Composer.vue'

export const name = 'ui-composer'
export const inject = ['slots', 'chatRuntime']

/** Register the `composer` factory and declare the action and dictation slots inside it. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.registerFactory({
    name: 'composer',
    children: { 'composer.actions': 'list', 'composer.dictation': 'single' },
    inject: () => ({
      catalog: (options: { signal: AbortSignal }) => runtime.promptCatalog(options),
      webSearch: runtime.webSearch,
      model: runtime.model
    })
  }, Composer)
}
