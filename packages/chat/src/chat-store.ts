import type { HistoryBackup } from '@keundal/backup'
import type { ExecutionOptions, AGUIEvent } from '@keundal/core'
import type { GenerationSnapshot } from '@keundal/generation'
import type { Reasoning } from '@keundal/llm'
import type { PromptPreset } from '@keundal/prompt'
import type { SubagentRole } from '@keundal/subagent'

import type { ChatMessage } from './chat-message'
export interface ChatStoreLike {
  readonly backup?: {
    export(): Promise<HistoryBackup>
    import(data: HistoryBackup): Promise<void>
  }
  respondToToolApproval?(runId: string, requestId: string, decision: 'allow' | 'deny'): Promise<boolean>
  list(): Promise<LocalChat[]>
  listSummaries?(): Promise<ChatSummary[]>
  get(id: string): Promise<LocalChat | undefined>
  create(id: string, message: ChatMessage, model: string): Promise<LocalChat>
  rename(id: string, title: string): Promise<void>
  truncate(id: string, messageId: string, type: 'edit' | 'regenerate'): Promise<void>
  /**
   * 선택한 사용자·어시스턴트 메시지까지 복사한 새 대화를 `newId`로 만들고 돌려줍니다. 원래 대화는
   * 바꾸지 않으며 실행 중에도 호출할 수 있습니다. 복사 규칙은 `branchChat()`을 따릅니다.
   */
  branch(sourceId: string, messageId: string, newId: string): Promise<LocalChat>
  vote(id: string, messageId: string, isUpvoted?: boolean): Promise<void>
  delete(id: string): Promise<void>
  getRun(runId: string, options?: ExecutionOptions): Promise<GenerationSnapshot | undefined>
  respond(
    id: string,
    request: {
      messages: ChatMessage[]
      model: string
      titleModel?: string
      /** Optional user-provided instructions for model responses; excluded from title generation. */
      systemPrompt?: string
      /** Ordered prompt recipe, captured for this response only. */
      promptPreset?: PromptPreset
      subagentRoles?: readonly SubagentRole[]
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

export type ChatSummary = Pick<LocalChat, 'id' | 'title' | 'createdAt'>

export function chatSummary(chat: ChatSummary): ChatSummary {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt }
}

/** Supports older platform plugins while keeping UI caches free of message history. */
export async function listChatSummaries(store: Pick<ChatStoreLike, 'list' | 'listSummaries'>): Promise<ChatSummary[]> {
  return (await (store.listSummaries ? store.listSummaries() : store.list())).map(chatSummary)
}

/**
 * 대화를 `messageId`까지 복사한 새 대화를 만듭니다. 원래 대화는 읽기만 하며 두 저장소 구현이 같은
 * 규칙을 쓰도록 이 함수 하나에 둡니다.
 *
 * - 메시지: 선택한 메시지를 포함해 앞쪽을 깊은 복사합니다. 선택한 메시지 바로 뒤에 이어지는 지시
 *   메시지(`metadata.steeredRunId`)는 앞선 어시스턴트 응답에 속하므로 함께 복사합니다. 어시스턴트 기록에
 *   이미 그 지시가 들어 있어 떼어 놓으면 화면과 모델 입력이 어긋납니다.
 * - 어시스턴트 메시지 `id`: 그대로 둡니다. 이 `id`가 원래 실행의 `runId`이므로 실행 추적 패널은
 *   원래 대화가 남아 있는 동안 원래 실행의 기록을 보여 주고, 원래 대화를 지운 뒤에는 `getRun()`이
 *   `undefined`를 돌려주어 기록 없음으로 표시합니다. journal은 복제하지 않습니다.
 * - 투표: 복사한 메시지에 달린 투표만 `chatId`를 새 대화로 바꿔 유지합니다.
 * - `pendingRunId`와 `queue`: 복사하지 않습니다. 진행 중인 실행과 대기 메시지는 원래 대화의 것입니다.
 * - 제목: 그대로 복사합니다. 제목이 없으면 첫 응답 때 새로 만듭니다.
 * - `createdAt`: 분기한 시각입니다. 목록은 최신 대화를 앞에 두므로 분기한 대화가 맨 위에 옵니다.
 * - `started`: 항상 `true`입니다. 대화를 열 때 응답이 자동으로 시작되지 않게 합니다.
 *
 * 선택한 메시지가 없거나 사용자·어시스턴트 메시지가 아니면 거부합니다.
 */
export function branchChat(source: LocalChat, messageId: string, id: string, createdAt: string): LocalChat {
  const index = source.messages.findIndex((message) => message.id === messageId)
  const chosen = source.messages[index]
  if (!chosen || (chosen.role !== 'user' && chosen.role !== 'assistant')) throw new Error('Invalid message')
  let end = index + 1
  while (source.messages[end]?.metadata?.steeredRunId) end++
  const messages = structuredClone(source.messages.slice(0, end))
  return {
    id,
    title: source.title,
    createdAt,
    messages,
    votes: source.votes
      .filter((vote) => messages.some((message) => message.id === vote.messageId))
      .map((vote) => ({ ...vote, chatId: id })),
    model: source.model,
    started: true,
    isOwner: true,
    visibility: 'private'
  }
}

/** Manual and generated titles share the same durable display contract. */
export function validateChatTitle(value: string): string {
  const title = value.trim()
  if (!title || title.length > 100) throw new Error('Title must contain 1–100 characters')
  return title
}
