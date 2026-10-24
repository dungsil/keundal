import type { Context } from 'cordis'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-slots'
import { lazyView } from '@keundal/ui-slots'

import type {} from './slots'

export const name = 'ui-composer'
export const inject = ['slots', 'chatRuntime']

const Composer = lazyView(() => import('./views/Composer.vue'), [
  'input',
  'setInput',
  'status',
  'error',
  'disabled',
  'files',
  'uploading',
  'openFiles',
  'removeFile',
  'submit',
  'stop',
  'reload',
  'delivery',
  'setDelivery',
  'variant',
  'catalog',
  'webSearch',
  'model'
])

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
