import type { AgentMessage } from '@keundal/core'

import type { ChatMessage, ChatPart } from './chat-message'
import type { LocalChat } from './chat-store'

/** 대화 하나에 쌓아 둘 수 있는 대기 메시지의 최대 수입니다. */
export const MAX_QUEUED_MESSAGES = 32

/**
 * 대화의 실행 중 상태입니다. 실행이 끝나기 전에는 세션 revision을 바꿀 수 없으므로, 실행 중에
 * 받은 대기 메시지와 지시는 여기에 모았다가 종료 커밋과 함께 확정합니다.
 */
export interface ActiveChatRun {
  readonly abort: AbortController
  readonly done: Promise<void>
  /** 생성 실행 id입니다. 실행을 시작하기 전에는 비어 있습니다. */
  runId?: string
  /** 종료를 확정하는 중이면 새 지시와 대기 메시지를 이 실행에 붙이지 않습니다. */
  closing: boolean
  /** 이 실행에 지시로 보낸 메시지입니다. 반영되지 않은 지시는 대기열 앞으로 옮깁니다. */
  readonly submitted: ChatMessage[]
  /** 실행 중에 대기열에 추가한 메시지입니다. */
  readonly queued: ChatMessage[]
  /** 실행 중에 취소한 저장된 대기 메시지 id입니다. */
  readonly removed: Set<string>
}

export function createActiveChatRun(abort: AbortController, done: Promise<void>): ActiveChatRun {
  return { abort, done, closing: false, submitted: [], queued: [], removed: new Set() }
}

/**
 * 대기열 끝에 메시지를 추가합니다. 같은 id가 이미 대기 중이면 중복 요청으로 보고 그대로 두며,
 * 상한을 넘으면 거부해 대기열이 끝없이 늘어나지 않게 합니다.
 */
export function queueMessage(queue: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (message.role !== 'user') throw new Error('Only user messages can be queued')
  if (queue.some((queued) => queued.id === message.id)) return [...queue]
  if (queue.length >= MAX_QUEUED_MESSAGES) throw new Error(`The queue is full (${MAX_QUEUED_MESSAGES})`)
  return [...queue, message]
}

/** 실행 중인 대화가 화면에 보여 줄 대기열입니다. 저장된 대기열에 실행 중 변경을 겹칩니다. */
export function visibleQueue(chat: LocalChat | undefined, active: ActiveChatRun | undefined): ChatMessage[] {
  const stored = (chat?.queue ?? []).filter((message) => !active?.removed.has(message.id))
  return [...stored, ...(active?.queued ?? [])]
}

/** journal에 반영된 지시를 화면 표시용 사용자 메시지로 바꿉니다. */
export function steeredChatMessage(message: Extract<AgentMessage, { role: 'user' }>, runId: string): ChatMessage {
  const parts: ChatPart[] = []
  if (typeof message.content === 'string') parts.push({ type: 'text', text: message.content })
  else {
    for (const part of message.content) {
      if (part.type === 'text') parts.push({ type: 'text', text: part.text })
      else if (part.type === 'image') {
        const url =
          part.source.type === 'data' ? `data:${part.source.mimeType};base64,${part.source.value}` : part.source.value
        parts.push({ type: 'file', mediaType: part.source.mimeType ?? 'image/*', url })
      }
    }
  }
  return { id: message.id, role: 'user', parts, metadata: { steeredRunId: runId } }
}

/**
 * 실행 중에 모은 대기열 변경을 저장된 대기열에 합칩니다. 반영되지 않은 지시는 보낸 순서대로
 * 대기열 앞에 두고, 같은 id는 한 번만 남깁니다.
 */
export function mergeRunQueue(
  chat: LocalChat,
  active: ActiveChatRun | undefined,
  applied: ReadonlySet<string> = new Set()
): ChatMessage[] | undefined {
  let queue: ChatMessage[] = []
  for (const message of [
    ...(active?.submitted ?? []).filter((submitted) => !applied.has(submitted.id)),
    ...visibleQueue(chat, active)
  ]) {
    if (!queue.some((queued) => queued.id === message.id)) queue = [...queue, message]
  }
  return queue.length ? queue : undefined
}

/** 실행 중에 모은 대기열 변경이 있는지 확인합니다. */
export function hasRunQueueChanges(active: ActiveChatRun): boolean {
  return active.submitted.length > 0 || active.queued.length > 0 || active.removed.size > 0
}

/**
 * 실행 결과를 대화에 확정합니다. 어시스턴트 응답 뒤에 반영된 지시를 표시하고, 반영되지 않은
 * 지시는 보낸 순서대로 대기열 앞에 둡니다. 실행 중에 추가하거나 취소한 대기 메시지도 함께
 * 반영하므로 한 번의 커밋으로 메시지와 대기열이 바뀝니다.
 */
export function settleChatRun(
  chat: LocalChat,
  run: {
    readonly runId: string
    readonly message: ChatMessage
    readonly steered: readonly Extract<AgentMessage, { role: 'user' }>[]
  },
  active?: ActiveChatRun
): LocalChat {
  const applied = new Set(run.steered.map((message) => message.id))
  return {
    ...chat,
    messages: [...chat.messages, run.message, ...run.steered.map((message) => steeredChatMessage(message, run.runId))],
    pendingRunId: undefined,
    queue: mergeRunQueue(chat, active, applied)
  }
}

/** 대기열을 저장된 대화에 반영하는 방법입니다. 저장소 구현이 revision 검사를 담당합니다. */
export interface ChatRunStorage {
  read(id: string): Promise<LocalChat | undefined>
  /** 저장된 대화를 다시 읽어 바꾼 뒤 기준 revision으로 저장하고 저장한 대화를 돌려줍니다. */
  write(id: string, change: (chat: LocalChat) => LocalChat): Promise<LocalChat>
}

/**
 * 대화별 실행 상태와 대기열·지시 처리를 묶습니다. 대화마다 실행은 하나만 두고, 다른 대화의 실행과
 * 대기열은 서로 기다리지 않습니다. 실행 중에는 세션을 바꾸지 않고 메모리에 모았다가 종료 커밋에서
 * 확정하며, 실행이 없을 때는 바로 저장합니다.
 */
export class ChatRuns<T extends ActiveChatRun = ActiveChatRun> {
  readonly active = new Map<string, T>()

  constructor(private readonly storage: ChatRunStorage) {}

  /** 종료를 확정하는 중인 실행이 있으면 끝날 때까지 기다린 뒤 현재 실행을 돌려줍니다. */
  private async current(id: string): Promise<T | undefined> {
    let run = this.active.get(id)
    while (run?.closing) {
      await run.done
      run = this.active.get(id)
    }
    return run
  }

  async enqueue(id: string, message: ChatMessage): Promise<ChatMessage[]> {
    const run = await this.current(id)
    if (run) {
      const visible = visibleQueue(await this.storage.read(id), run)
      // 읽는 동안 종료 확정이 시작됐으면 그 커밋이 끝난 뒤 저장된 대기열에 추가합니다.
      if (run.closing) return this.enqueue(id, message)
      const queue = queueMessage(visible, message)
      if (queue.length > visible.length) run.queued.push(message)
      return queue
    }
    const saved = await this.storage.write(id, (chat) => ({ ...chat, queue: queueMessage(chat.queue ?? [], message) }))
    return saved.queue ?? []
  }

  async dequeue(id: string, messageId: string): Promise<ChatMessage[]> {
    const run = await this.current(id)
    if (run) {
      const index = run.queued.findIndex((queued) => queued.id === messageId)
      if (index >= 0) run.queued.splice(index, 1)
      else run.removed.add(messageId)
      return visibleQueue(await this.storage.read(id), run)
    }
    const saved = await this.storage.write(id, (chat) => {
      const queue = (chat.queue ?? []).filter((queued) => queued.id !== messageId)
      return { ...chat, queue: queue.length ? queue : undefined }
    })
    return saved.queue ?? []
  }

  /**
   * 실행 중인 대화에 지시를 전달합니다. 종료 확정과 겹쳐도 지시를 잃지 않도록 전달 전에 먼저
   * 기록하고, 전달이 거부되면 기록을 되돌립니다. 반영되지 않은 지시는 종료 커밋에서 대기열 앞으로
   * 옮겨집니다.
   */
  async steer(id: string, message: ChatMessage, deliver: (run: T) => Promise<boolean>): Promise<boolean> {
    if (message.role !== 'user') throw new Error('Only user messages can steer a run')
    const run = this.active.get(id)
    if (!run || run.closing || !run.runId) return false
    if (run.submitted.some((submitted) => submitted.id === message.id)) return true
    run.submitted.push(message)
    let accepted = false
    try {
      accepted = await deliver(run)
    } finally {
      if (!accepted) {
        const index = run.submitted.findIndex((submitted) => submitted.id === message.id)
        if (index >= 0) run.submitted.splice(index, 1)
      }
    }
    return accepted
  }

  /**
   * 실행 등록을 해제합니다. 종료 커밋이 대기열 변경을 확정하지 못했으면 대기 메시지와 반영되지
   * 않은 지시를 잃지 않도록 저장된 대기열에 합칩니다.
   */
  async release(id: string, run: T, settled: boolean): Promise<void> {
    run.closing = true
    try {
      // 등록을 유지한 채 저장해, 그동안 들어온 대기 요청이 이 커밋 뒤에 저장되도록 합니다.
      if (!settled && hasRunQueueChanges(run))
        await this.storage.write(id, (chat) => ({ ...chat, queue: mergeRunQueue(chat, run) }))
    } finally {
      if (this.active.get(id) === run) this.active.delete(id)
    }
  }
}
