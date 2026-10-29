import type { Context } from 'cordis'
import type {} from '@keundal/ui-slots'

import type {} from '@keundal/ui/app/contracts/layout.ts'
import AppFrame from './views/AppFrame.vue'

export const name = 'ui-layout'
export const inject = ['slots']

export const metadata = {
  name: { en: 'Application layout', ko: '앱 레이아웃' },
  description: {
    en: 'Provides the application frame and slots for pages, the sidebar, and overlays.',
    ko: '앱의 기본 틀과 페이지·사이드바·오버레이 슬롯을 제공합니다.'
  }
}

/** Render the application frame at `root` and declare the page and sidebar slots inside it. */
export function apply(ctx: Context) {
  ctx.slots.register({
    name: 'root',
    children: {
      'page.home': 'single',
      'page.chat': 'single',
      'page.history': 'single',
      'page.settings': 'single',
      'layout.sidebar': 'list',
      'layout.sidebar.footer': 'list',
      'layout.overlay': 'list'
    }
  }, AppFrame)
}
