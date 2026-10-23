import type { Context } from 'cordis'
import type {} from '@keundal/ui-layout/slots'
import type {} from '@keundal/ui-runtime'
import { reactive } from 'vue'

import ChatActions from './views/ChatActions.vue'
import ChatHistory from './views/ChatHistory.vue'
import ChatSearch from './views/ChatSearch.vue'

export const name = 'ui-chat-list'
export const inject = ['slots', 'chatRuntime']

/** Render the new chat and search actions, the grouped chat history and the search dialog beside the pages. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  // Opened by the sidebar action and by the search dialog's own shortcut, so both entries share it.
  const search = reactive({ open: false })

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
        rename: (id: string, title: string) => runtime.renameChat(id, title),
        remove: (id: string) => runtime.deleteChat(id)
      })
    }, ChatHistory)
  ])
  ctx.slots.inject('layout.overlay', () => ctx.slots.register({
    name: 'layout.overlay',
    id: 'search',
    inject: () => ({
      chats: runtime.chats,
      search,
      setSearchOpen: (open: boolean) => {
        search.open = open
      }
    })
  }, ChatSearch))
}
