import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/contracts/layout.ts'
import AppSidebar from './views/AppSidebar.vue'

export const name = 'ui-sidebar'
export const inject = ['slots']

export const metadata = {
  name: { en: 'Sidebar', ko: '사이드바' },
  description: {
    en: 'Provides collapsible navigation, a resizable sidebar, and a narrow-screen drawer.',
    ko: '접고 펼치는 탐색 영역과 크기를 조절하는 사이드바, 좁은 화면의 메뉴를 제공합니다.'
  }
}

export function apply(ctx: Context) {
  ctx.slots.inject('layout.navigation', () => ctx.slots.register({
    name: 'layout.navigation',
    children: {
      'layout.sidebar': 'list',
      'layout.sidebar.footer': 'list'
    }
  }, AppSidebar))
}
