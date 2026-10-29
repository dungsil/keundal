import type { Context } from 'cordis'
import type { ChatMessage } from '@keundal/chat/chat-message'
import type {} from '@keundal/ui/app/contracts/composer.ts'
import type {} from '@keundal/ui/app/contracts/layout.ts'
import type {} from '@keundal/ui-runtime'

import HomePage from './views/HomePage.vue'

export const name = 'ui-home'
export const inject = ['slots', 'chatRuntime']

export const metadata = {
  name: { en: 'New conversation view', ko: '새 대화 화면' },
  description: {
    en: 'Provides the starting screen for new conversations.',
    ko: '새 대화를 시작하는 화면을 제공합니다.'
  }
}

/** Render the new-chat page at `page.home`. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('page.home', () => ctx.slots.register({
    name: 'page.home',
    inject: () => ({
      model: runtime.model,
      switching: runtime.switching,
      ensureConfigured: (model: string) => runtime.ensureConfigured(model),
      create: (id: string, message: ChatMessage, model: string) => runtime.store.create(id, message, model),
      refreshChats: () => runtime.refreshChats(),
      applyDefaultModel: () => runtime.applyDefaultModel()
    })
  }, HomePage))
}
