import type {} from '@keundal/ui/app/contracts/chat.ts'
import { lazyView } from '@keundal/ui-slots'
import type { Context } from 'cordis'

export const name = 'ui-chart'
export const inject = ['slots']

export const metadata = {
  name: { en: 'Chart result cards', ko: '차트 결과 카드' },
  description: {
    en: 'Renders chart tool results in conversations, including saved results.',
    ko: '저장된 결과를 포함해 대화의 차트 도구 결과를 표시합니다.'
  }
}

const Chart = lazyView(() => import('./views/Chart.vue'), ['part'])

export function apply(ctx: Context) {
  ctx.slots.inject('chat.message.tool', () =>
    ctx.slots.register({ name: 'chat.message.tool', key: 'chart' }, Chart)
  )
}
