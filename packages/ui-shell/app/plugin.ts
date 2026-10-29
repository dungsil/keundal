import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/contracts/layout.ts'
import type {} from '@keundal/ui-runtime'
import AppShell from './views/AppShell.vue'

export const name = 'ui-shell'
export const inject = ['slots', 'chatRuntime']

export const metadata = {
  name: { en: 'Application shell', ko: '앱 셸' },
  description: {
    en: 'Provides startup state, the application frame, and page and overlay slots.',
    ko: '시작 상태와 앱의 기본 틀, 페이지·오버레이 슬롯을 제공합니다.'
  }
}

export function apply(ctx: Context) {
  ctx.slots.register({
    name: 'root',
    children: {
      'page.home': 'single',
      'page.chat': 'single',
      'page.history': 'single',
      'page.settings': 'single',
      'layout.navigation': 'single',
      'layout.overlay': 'list'
    },
    inject: () => ({ ready: ctx.chatRuntime.ready })
  }, AppShell)
}
