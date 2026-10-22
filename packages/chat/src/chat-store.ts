import type { Reasoning, AGUIEvent } from '@keundal/core'

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
      reasoning?: Reasoning
      webSearch?: boolean
      onMessage?: (message: ChatMessage) => void
      onTitle?: (title: string) => void
    },
    signal?: AbortSignal
  ): AsyncGenerator<AGUIEvent>
  /**
   * 대화 끝의 대기열에 메시지를 추가하고 화면에 보일 대기열을 돌려줍니다. 실행 중에 추가한
   * 메시지는 실행이 끝날 때 함께 저장합니다. 대기열은 정상 종료 뒤에만 호출자가 순서대로 소비합니다.
   */
  enqueue(id: string, message: ChatMessage): Promise<ChatMessage[]>
  /** 아직 실행하지 않은 대기 메시지를 취소하고 남은 대기열을 돌려줍니다. */
  dequeue(id: string, messageId: string): Promise<ChatMessage[]>
  /**
   * 실행 중인 대화에 지시를 보냅니다. 받아들이면 true이며, 다음 모델 요청 전의 안전한 경계에서
   * 반영됩니다. 실행이 없거나 끝나는 중이면 false이므로 호출자가 대기열로 넘깁니다.
   */
  steer(id: string, message: ChatMessage): Promise<boolean>
  /**
   * 실행을 소유하는 위치입니다. browser는 탭을 닫으면 실행과 메모리의 대기열이 함께 끝나며,
   * host는 연결이 끊겨도 실행을 유지하고 다시 구독할 수 있습니다.
   */
  readonly execution: 'browser' | 'host'
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
  /** 정상 종료 뒤에 순서대로 보낼 사용자 메시지입니다. */
  queue?: ChatMessage[]
  isOwner: true
  visibility: 'private'
}

/** Manual and generated titles share the same durable display contract. */
export function validateChatTitle(value: string): string {
  const title = value.trim()
  if (!title || title.length > 100) throw new Error('Title must contain 1–100 characters')
  return title
}
