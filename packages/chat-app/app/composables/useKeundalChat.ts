import { EventType } from '@keundal/core'
import type { AGUIEvent } from '@keundal/core'
import { shallowRef } from 'vue'

import type { ChatMessage, ChatStatus, FilePart } from '@keundal/chat/chat-message'

/** 실행 중에 보낸 메시지를 처리하는 방법입니다. */
export type DeliveryMode = 'queue' | 'steer'

export function useKeundalChat(options: {
  respond: (
    messages: ChatMessage[],
    onMessage: (message: ChatMessage) => void,
    signal: AbortSignal
  ) => AsyncGenerator<AGUIEvent>
  /** 실행 중인 대화에 지시를 보냅니다. 받아들이지 않으면 대기열에 넣습니다. */
  steer?: (message: ChatMessage) => Promise<boolean>
  enqueue?: (message: ChatMessage) => Promise<ChatMessage[]>
  dequeue?: (messageId: string) => Promise<ChatMessage[]>
  /** 실행이 끝난 뒤 저장된 대화와 대기열을 다시 읽습니다. */
  load?: () => Promise<{ messages: ChatMessage[], queue?: ChatMessage[] } | undefined>
  onFinish?: () => Promise<void>
  onError?: (error: Error) => void
  onEvent?: (event: AGUIEvent) => void
}) {
  const messages = shallowRef<ChatMessage[]>([])
  const queue = shallowRef<ChatMessage[]>([])
  const status = shallowRef<ChatStatus>('ready')
  const error = shallowRef<Error>()
  let active: { abort: AbortController, done: Promise<boolean> } | undefined

  /** 실행 하나를 끝까지 진행하고, 사용자가 중단하지 않고 오류 없이 끝났으면 true를 돌려줍니다. */
  async function runOnce(): Promise<boolean> {
    if (active) return false
    const abort = new AbortController()
    error.value = undefined
    status.value = 'submitted'
    // Defer execution until active is assigned, including synchronous failures.
    const done = Promise.resolve().then(async () => {
      try {
        for await (const event of options.respond(
          messages.value,
          (message) => {
            const index = messages.value.findIndex(item => item.id === message.id)
            messages.value
              = index < 0
                ? [...messages.value, message]
                : messages.value.map(item => (item.id === message.id ? message : item))
            if (!abort.signal.aborted) status.value = 'streaming'
          },
          abort.signal
        )) {
          options.onEvent?.(event)
          if (event.type === EventType.RUN_ERROR && !abort.signal.aborted) {
            // Drain the iterator before reporting the error so partial output is saved.
            error.value = new Error(event.message)
          }
        }
        if (error.value) throw error.value
      } catch (cause) {
        if (!abort.signal.aborted) {
          error.value = cause instanceof Error ? cause : new Error(String(cause))
          options.onError?.(error.value)
        }
      } finally {
        status.value = error.value ? 'error' : 'ready'
        // 저장된 대화를 다시 읽는 동안 들어온 메시지도 대기열로 보내도록 실행 상태를 마지막에 해제합니다.
        try {
          await sync()
          await options.onFinish?.()
        } finally {
          active = undefined
        }
      }
      return !abort.signal.aborted && !error.value
    })
    active = { abort, done }
    return done
  }

  async function sync() {
    const saved = await options.load?.().catch(() => undefined)
    if (!saved) return
    messages.value = saved.messages
    queue.value = saved.queue ?? []
  }

  /**
   * 실행을 시작하고, 정상 종료하면 대기열의 다음 메시지를 순서대로 보냅니다. 중단하거나 실패하면
   * 대기열을 남겨 두고 멈춥니다.
   */
  async function run() {
    let succeeded = await runOnce()
    while (succeeded && queue.value[0]) {
      messages.value = [...messages.value, queue.value[0]]
      succeeded = await runOnce()
    }
  }

  async function stop() {
    const current = active
    current?.abort.abort()
    await current?.done
  }

  function createMessage(input: { text: string, files?: FilePart[], messageId?: string }): ChatMessage {
    return {
      id: input.messageId ?? crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: input.text }, ...(input.files ?? [])]
    }
  }

  async function sendMessage(input: { text: string, files?: FilePart[], messageId?: string, mode?: DeliveryMode }) {
    if (active) {
      if (input.messageId || !options.enqueue) return
      const message = createMessage(input)
      if (input.mode === 'steer' && options.steer && await options.steer(message)) {
        messages.value = [...messages.value, message]
        return
      }
      queue.value = await options.enqueue(message)
      return
    }
    const message = createMessage(input)
    if (input.messageId) {
      const index = messages.value.findIndex(item => item.id === input.messageId && item.role === 'user')
      if (index < 0) throw new Error('User message not found')
      messages.value = [...messages.value.slice(0, index), message]
    } else messages.value = [...messages.value, message]
    await run()
  }

  /** 멈춘 대기열을 다시 처리합니다. */
  async function resumeQueue() {
    if (active || !queue.value[0]) return
    messages.value = [...messages.value, queue.value[0]]
    await run()
  }

  async function removeQueued(messageId: string) {
    if (!options.dequeue) return
    queue.value = await options.dequeue(messageId)
  }

  async function regenerate(input?: { messageId: string }) {
    if (active) return
    if (input) {
      const index = messages.value.findIndex(item => item.id === input.messageId && item.role === 'assistant')
      if (index < 0) throw new Error('Assistant message not found')
      messages.value = messages.value.slice(0, index)
    } else if (messages.value.at(-1)?.role === 'assistant') messages.value = messages.value.slice(0, -1)
    await run()
  }

  return { messages, queue, status, error, sendMessage, regenerate, stop, resumeQueue, removeQueued }
}
