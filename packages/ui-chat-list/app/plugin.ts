import type { Context } from 'cordis'
import type {} from '@keundal/ui-layout/slots'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import { computed, reactive } from 'vue'

import ChatActions from './views/ChatActions.vue'
import ChatHistory from './views/ChatHistory.vue'
import ChatSearch from './views/ChatSearch.vue'
import HistoryPage from './views/HistoryPage.vue'

export const name = 'ui-chat-list'
export const inject = ['slots', 'chatRuntime']

/** Render the new chat, search and history actions, the grouped chat history, the search dialog and the history page. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  // Opened by the sidebar action and by the search dialog's own shortcut, so both entries share it.
  const search = reactive({ open: false })
  const rename = (id: string, title: string) => runtime.renameChat(id, title)
  const remove = (id: string) => runtime.deleteChat(id)
  // The search dialog lists the settings sections other plugins register.
  const settingsSections = computed(() => {
    void ctx.slots.version.value
    return ctx.slots.describe('settings.section')
  })

  ctx.slots.inject('layout.sidebar', () => [
    ctx.slots.register({
      name: 'layout.sidebar',
      id: 'actions',
      order: 0,
      inject: () => ({
        openSearch: () => {
          search.open = true
        }
      })
    }, ChatActions),
    ctx.slots.register({
      name: 'layout.sidebar',
      id: 'history',
      order: 10,
      inject: () => ({
        chats: runtime.chats,
        rename,
        remove
      })
    }, ChatHistory)
  ])
  ctx.slots.inject('layout.overlay', () => ctx.slots.register({
    name: 'layout.overlay',
    id: 'search',
    inject: () => ({
      chats: runtime.chats,
      settingsSections,
      search,
      setSearchOpen: (open: boolean) => {
        search.open = open
      },
      rename,
      remove
    })
  }, ChatSearch))
  ctx.slots.inject('page.history', () => ctx.slots.register({
    name: 'page.history',
    inject: () => ({ chats: runtime.chats })
  }, HistoryPage))
}
