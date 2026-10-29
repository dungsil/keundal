import type { ChatMessage } from '@keundal/chat/chat-message'
import type { ChatStoreLike } from '@keundal/chat/chat-store'
import type { Context } from 'cordis'
import type {} from '@keundal/ui/app/contracts/layout.ts'
import type {} from '@keundal/ui-runtime'
import { lazyView } from '@keundal/ui-slots'

import type {} from '@keundal/ui/app/contracts/chat.ts'

export const name = 'ui-chat'
export const inject = ['slots', 'chatRuntime']

export const metadata = {
  name: { en: 'Conversation view', ko: '대화 화면' },
  description: {
    en: 'Displays conversations and provides message editing, branching, and response controls.',
    ko: '대화를 표시하고 메시지 편집·분기와 응답 제어를 제공합니다.'
  }
}

const ChatPage = lazyView(() => import('./views/ChatPage.vue'), [
  'chatId',
  'model',
  'titleModel',
  'promptPreset',
  'subagentRoles',
  'webSearch',
  'reasoning',
  'chats',
  'ensureConfigured',
  'setPending',
  'refreshChats',
  'rename',
  'remove',
  'getChat',
  'respond',
  'respondToToolApproval',
  'steer',
  'enqueue',
  'dequeue',
  'truncate',
  'branch',
  'saveVote',
  'isBrowserOnly'
])

/** Render the conversation page and declare the slots that other plugins use to extend it. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('page.chat', () => ctx.slots.register({
    name: 'page.chat',
    children: {
      'chat.message.tool': 'keyed',
      'chat.message.footer': 'list',
      'chat.indicator': 'list',
      'chat.observer': 'list',
      'chat.execution': 'list'
    },
    // The store is read lazily inside each callback: it does not exist until the runtime connects in the browser.
    inject: ({ chatId }) => ({
      chatId,
      model: runtime.model,
      titleModel: runtime.titleModel,
      promptPreset: runtime.promptPreset,
      subagentRoles: runtime.subagentRoles,
      webSearch: runtime.webSearch,
      reasoning: runtime.reasoning,
      chats: runtime.chats,
      ensureConfigured: (model: string) => runtime.ensureConfigured(model),
      setPending: (pending: boolean) => runtime.setPending('chat', pending),
      refreshChats: () => runtime.refreshChats(),
      rename: (id: string, title: string) => runtime.renameChat(id, title),
      remove: (id: string) => runtime.deleteChat(id),
      getChat: () => runtime.store.get(chatId),
      respond: (request: Parameters<ChatStoreLike['respond']>[1], signal?: AbortSignal) => runtime.store.respond(chatId, {
        ...request, memoryProjectId: runtime.memoryProject.value || undefined,
        modelRecovery: runtime.modelRecovery.value, budget: runtime.runBudget.value
      }, signal),
      steer: (message: ChatMessage) => runtime.store.steer(chatId, message),
      respondToToolApproval: (runId: string, requestId: string, decision: 'allow' | 'deny') => runtime.store.respondToToolApproval?.(runId, requestId, decision) ?? Promise.resolve(false),
      enqueue: (message: ChatMessage) => runtime.store.enqueue(chatId, message),
      dequeue: (messageId: string) => runtime.store.dequeue(chatId, messageId),
      truncate: (messageId: string, type: 'edit' | 'regenerate') => runtime.store.truncate(chatId, messageId, type),
      branch: (messageId: string, newId: string) => runtime.store.branch(chatId, messageId, newId),
      saveVote: (messageId: string, isUpvoted?: boolean) => runtime.store.vote(chatId, messageId, isUpvoted),
      isBrowserOnly: () => runtime.store.execution === 'browser'
    })
  }, ChatPage))
}
