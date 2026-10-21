import { EventType } from '@keundal/core'
import type { AGUIEvent } from '@keundal/core'
import { shallowRef } from 'vue'

import type { ChatMessage, ChatStatus, FilePart } from '@keundal/chat/chat-message'

export function useKeundalChat(options: {
  respond: (
    messages: ChatMessage[],
    onMessage: (message: ChatMessage) => void,
    signal: AbortSignal
  ) => AsyncGenerator<AGUIEvent>
  onFinish?: () => Promise<void>
  onError?: (error: Error) => void
  onEvent?: (event: AGUIEvent) => void
}) {
  const messages = shallowRef<ChatMessage[]>([])
  const status = shallowRef<ChatStatus>('ready')
  const error = shallowRef<Error>()
  let active: { abort: AbortController, done: Promise<void> } | undefined

  async function run() {
    if (active) return
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
        active = undefined
        status.value = error.value ? 'error' : 'ready'
        await options.onFinish?.()
      }
    })
    active = { abort, done }
    await done
  }

  async function stop() {
    const current = active
    current?.abort.abort()
    await current?.done
  }

  async function sendMessage(input: { text: string, files?: FilePart[], messageId?: string }) {
    if (active) return
    const message: ChatMessage = {
      id: input.messageId ?? crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: input.text }, ...(input.files ?? [])]
    }
    if (input.messageId) {
      const index = messages.value.findIndex(item => item.id === input.messageId && item.role === 'user')
      if (index < 0) throw new Error('User message not found')
      messages.value = [...messages.value.slice(0, index), message]
    } else messages.value = [...messages.value, message]
    await run()
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

  return { messages, status, error, sendMessage, regenerate, stop }
}
