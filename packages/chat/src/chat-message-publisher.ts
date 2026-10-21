import { EventType, type AGUIEvent } from '@keundal/core'

import type { ChatMessage } from './chat-message'

/** Coalesces immutable UI snapshots without dropping events or durable state. */
export class ChatMessagePublisher {
  private remaining = 16 * 1024 * 1024
  private lastPublished = -Infinity
  private hasContent = false
  private pending?: ChatMessage
  private timer?: ReturnType<typeof setTimeout>
  private callbackError?: unknown

  constructor(private readonly onMessage?: (message: ChatMessage) => void) {}

  update(event: AGUIEvent, message: ChatMessage) {
    if (this.callbackError) throw this.callbackError
    if (!this.onMessage || this.remaining <= 0) return
    this.pending = message
    const firstContent =
      !this.hasContent &&
      (event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.REASONING_MESSAGE_CONTENT) &&
      event.delta.length > 0
    if (firstContent) this.hasContent = true
    const delay = Math.max(0, 50 - (performance.now() - this.lastPublished))
    if (firstContent || delay === 0) this.publish()
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        try {
          this.publish()
        } catch (error) {
          // Surface callback failures through the consuming iterator, never an
          // unhandled timer exception.
          this.callbackError = error
        }
      }, delay)
    }
  }

  private publish() {
    clearTimeout(this.timer)
    this.timer = undefined
    const message = this.pending
    this.pending = undefined
    if (!message || !this.onMessage || this.remaining <= 0) return
    // A time interval alone still permits quadratic copies from slow streams.
    // Bound cumulative serialization and copying, then defer further UI updates
    // to completion. Event processing and durable output remain lossless.
    const size = JSON.stringify(message).length
    this.remaining -= size
    if (this.remaining < 0) return
    this.lastPublished = performance.now()
    this.onMessage(structuredClone(message))
  }

  finish(message: ChatMessage) {
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
    if (this.callbackError) throw this.callbackError
    this.onMessage?.(structuredClone(message))
  }
}
