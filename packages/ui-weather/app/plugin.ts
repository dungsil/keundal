import type {} from '@keundal/ui/app/contracts/chat.ts'
import { lazyView } from '@keundal/ui-slots'
import type { Context } from 'cordis'

export const name = 'ui-weather'
export const inject = ['slots']

export const metadata = {
  name: { en: 'Weather result cards', ko: '날씨 결과 카드' },
  description: {
    en: 'Renders weather tool results in conversations, including saved results.',
    ko: '저장된 결과를 포함해 대화의 날씨 도구 결과를 표시합니다.'
  }
}

const Weather = lazyView(() => import('./views/Weather.vue'), ['part'])

export function apply(ctx: Context) {
  ctx.slots.inject('chat.message.tool', () =>
    ctx.slots.register({ name: 'chat.message.tool', key: 'weather' }, Weather)
  )
}
