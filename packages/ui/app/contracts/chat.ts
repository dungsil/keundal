import type { ChatMessage, ChatStatus, ToolPart } from '@keundal/chat/chat-message'
import type { AGUIEvent } from '@keundal/core'
import type {} from '@keundal/ui-slots'

/** Shared slot contracts; implementations own their runtime declarations. */
/** Values a tool view receives. The entry `key` is the tool name, `part.type` without the `tool-` prefix. */
export interface ChatToolOwner {
  part: ToolPart
  message: ChatMessage
}

/** Values every entry below one message receives. */
export interface ChatMessageFooterOwner {
  chatId: string
  message: ChatMessage
  messages: readonly ChatMessage[]
  status: ChatStatus
}

/** Values every entry beside the pending-response indicator receives. */
export interface ChatIndicatorOwner {
  chatId: string
  messages: readonly ChatMessage[]
  status: ChatStatus
}

/** Values a renderless observer receives for the lifetime of a conversation page. */
export interface ChatObserverOwner {
  chatId: string
  /** Run that was still active when the conversation loaded. */
  pendingRunId?: string
  /** Receive every run event of this page. Returns the unsubscribe function. */
  subscribe(listener: (event: AGUIEvent) => void): () => void
}

declare module '@keundal/ui-slots' {
  interface SlotMap {
    /** Execution panels separate from assistant message content. */
    'chat.execution': { kind: 'list'; owner: ChatIndicatorOwner }
    /** Tool call views keyed by tool name. A generic card renders for tools without an entry. */
    'chat.message.tool': { kind: 'keyed'; owner: ChatToolOwner }
    /** Content below each message, ordered by `order`. */
    'chat.message.footer': { kind: 'list'; owner: ChatMessageFooterOwner }
    /** Content beside the indicator shown before the first response arrives. */
    'chat.indicator': { kind: 'list'; owner: ChatIndicatorOwner }
    /** Renderless components that follow the page's run events. */
    'chat.observer': { kind: 'list'; owner: ChatObserverOwner }
  }
}
