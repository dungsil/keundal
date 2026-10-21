import type { AGUIEvent } from '@keundal/core'

import type { ChatMessage } from './chat-message'
export interface ChatStoreLike {
  list(): Promise<LocalChat[]>
  get(id: string): Promise<LocalChat | undefined>
  create(id: string, message: ChatMessage, model: string): Promise<LocalChat>
  rename(id: string, title: string): Promise<void>
  truncate(id: string, messageId: string, type: 'edit' | 'regenerate'): Promise<void>
  vote(id: string, messageId: string, isUpvoted?: boolean): Promise<void>
  delete(id: string): Promise<void>
  respond(
    id: string,
    request: {
      messages: ChatMessage[]
      model: string
      titleModel?: string
      reasoning?: boolean
      webSearch?: boolean
      onMessage?: (message: ChatMessage) => void
      onTitle?: (title: string) => void
    },
    signal?: AbortSignal
  ): AsyncGenerator<AGUIEvent>
  recover(): Promise<void>
  stop(): Promise<void>
}

export interface LocalChat {
  id: string
  title: string | null
  createdAt: string
  messages: ChatMessage[]
  votes: { chatId: string; messageId: string; isUpvoted: boolean }[]
  model: string
  started: boolean
  pendingRunId?: string
  isOwner: true
  visibility: 'private'
}

/** Manual and generated titles share the same durable display contract. */
export function validateChatTitle(value: string): string {
  const title = value.trim()
  if (!title || title.length > 100) throw new Error('Title must contain 1–100 characters')
  return title
}
