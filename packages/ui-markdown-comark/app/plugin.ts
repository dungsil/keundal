import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/types/markdown.ts'
import { lazyView } from '@keundal/ui-slots'

export const name = 'ui-markdown-comark'
export const inject = ['slots']

export const metadata = {
  name: { en: 'Markdown rendering', ko: 'Markdown 표시' },
  description: {
    en: 'Renders Markdown with code highlighting and source citations using Comark.',
    ko: 'Comark로 Markdown 본문과 코드 강조, 출처 인용을 표시합니다.'
  }
}

const Comark = lazyView(() => import('./views/Comark'), ['value', 'streaming', 'sources'])

export function apply(ctx: Context) {
  ctx.slots.registerFactory({ name: 'markdown' }, Comark)
}
