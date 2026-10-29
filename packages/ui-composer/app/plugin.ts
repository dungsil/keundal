import type { Context } from 'cordis'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-slots'
import type {} from '@keundal/ui/app/contracts/composer.ts'
import Composer from './views/Composer.vue'

export const name = 'ui-composer'
export const inject = ['slots', 'chatRuntime']

export const metadata = {
  name: { en: 'Message composer', ko: '메시지 입력' },
  description: {
    en: 'Provides message input, attachments, and prompt selection.',
    ko: '메시지 입력과 첨부, 프롬프트 선택 기능을 제공합니다.'
  }
}

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
