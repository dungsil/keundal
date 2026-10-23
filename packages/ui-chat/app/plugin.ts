import type { ChatMessage } from '@keundal/chat/chat-message'
import type { ChatStoreLike } from '@keundal/chat/chat-store'
import type { Context } from 'cordis'
import type {} from '@keundal/ui-layout/slots'
import type {} from '@keundal/ui-runtime'

import type {} from './slots'
import ChatPage from './views/ChatPage.vue'

export const name = 'ui-chat'
export const inject = ['slots', 'chatRuntime']

/** Render the conversation page and declare the slots that other plugins use to extend it. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('page.chat', () => ctx.slots.register({
    name: 'page.chat',
    children: {
      'chat.message.tool': 'keyed',
      'chat.message.footer': 'list',
      'chat.indicator': 'list',
      'chat.observer': 'list'
    },
    // The store is read lazily inside each callback: it does not exist until the runtime connects in the browser.
    inject: ({ chatId }) => ({
      model: runtime.model,
      titleModel: runtime.titleModel,
      webSearch: runtime.webSearch,
      reasoning: runtime.reasoning,
      chats: runtime.chats,
      ensureConfigured: (model: string) => runtime.ensureConfigured(model),
      setPending: (pending: boolean) => runtime.setPending('chat', pending),
      refreshChats: () => runtime.refreshChats(),
      rename: (id: string, title: string) => runtime.renameChat(id, title),
      remove: (id: string) => runtime.deleteChat(id),
      getChat: () => runtime.store.get(chatId),
      respond: (request: Parameters<ChatStoreLike['respond']>[1], signal?: AbortSignal) => runtime.store.respond(chatId, request, signal),
      steer: (message: ChatMessage) => runtime.store.steer(chatId, message),
      enqueue: (message: ChatMessage) => runtime.store.enqueue(chatId, message),
      dequeue: (messageId: string) => runtime.store.dequeue(chatId, messageId),
      truncate: (messageId: string, type: 'edit' | 'regenerate') => runtime.store.truncate(chatId, messageId, type),
      branch: (messageId: string, newId: string) => runtime.store.branch(chatId, messageId, newId),
      saveVote: (messageId: string, isUpvoted?: boolean) => runtime.store.vote(chatId, messageId, isUpvoted),
      isBrowserOnly: () => runtime.store.execution === 'browser'
    })
  }, ChatPage))
}
