import console from 'node:console'
import { createHash } from 'node:crypto'

import {
  NotificationService,
  type Notification,
  type NotificationDelivery,
  type NotificationStore
} from '@keundal/notification'
import type { Context } from 'cordis'

export interface WebhookNotificationOptions {
  url: string
  /** Optional Bearer credential, held only in host memory. */
  token?: string
}

/** Durable bounded retries; the receiver participates in deduplication via Idempotency-Key. */
export class WebhookNotificationService extends NotificationService {
  private readonly url: string
  private readonly target: string
  private readonly headers: Headers
  private readonly controller = new globalThis.AbortController()
  private timer?: ReturnType<typeof globalThis.setInterval>
  private pending?: Promise<void>
  private closed = false

  constructor(
    ctx: Context,
    private readonly store: NotificationStore,
    options: WebhookNotificationOptions
  ) {
    super(ctx)
    let url: URL
    try {
      url = new globalThis.URL(options.url)
    } catch {
      throw new Error('invalid notification Webhook URL')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error('notification Webhook requires HTTP(S), without userinfo or fragments')
    this.url = url.href
    this.target = createHash('sha256').update(this.url).digest('hex')
    try {
      this.headers = new globalThis.Headers({
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      })
    } catch {
      throw new Error('invalid notification Webhook headers')
    }
  }

  start(): void {
    if (this.closed || this.timer) throw new Error('notification already started or disposed')
    this.timer = globalThis.setInterval(() => {
      void this.tick().catch(() => console.error('notification delivery storage failed'))
    }, 1000)
    this.timer.unref()
  }

  async notify(notification: Notification): Promise<void> {
    if (this.closed) throw new Error('notification disposed')
    await this.store.claim({
      notification,
      target: this.target,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: Date.now()
    })
  }

  /** Coalesces concurrent ticks rather than accumulating network work behind the timer. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.pending ??= this.deliver().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  async dispose(): Promise<void> {
    this.closed = true
    globalThis.clearInterval(this.timer)
    this.controller.abort()
    await this.pending
  }

  private async deliver(): Promise<void> {
    for (const delivery of await this.store.list(this.target)) {
      if (this.closed) return
      if (delivery.status !== 'pending' || delivery.nextAttemptAt > Date.now()) continue
      // Persist before sending so crashes cannot reset the retry budget.
      if (delivery.attempts >= 5) {
        await this.store.save({ ...delivery, status: 'failed', error: 'retry limit reached' })
        continue
      }
      const attempt: NotificationDelivery = { ...delivery, attempts: delivery.attempts + 1 }
      await this.store.save(attempt)
      let delivered = false
      let retryable = true
      let retryAfter = 0
      let error = 'network error or timeout'
      try {
        const headers = new globalThis.Headers(this.headers)
        headers.set('Idempotency-Key', delivery.notification.id)
        const response = await globalThis.fetch(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(delivery.notification),
          redirect: 'manual',
          signal: globalThis.AbortSignal.any([this.controller.signal, globalThis.AbortSignal.timeout(10_000)])
        })
        await response.body?.cancel()
        delivered = response.ok
        error = `HTTP ${response.status}`
        retryable = response.status === 408 || response.status === 429 || response.status >= 500
        const value = response.headers.get('Retry-After')
        if (value && (response.status === 429 || response.status === 503)) {
          const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
          if (Number.isFinite(delay)) retryAfter = Math.min(60_000, Math.max(0, delay))
        }
      } catch {
        // URLs, tokens, provider response bodies and fetch error causes are not persisted or logged.
      }
      if (delivered) {
        await this.store.save({ ...attempt, status: 'delivered', error: undefined })
        continue
      }
      await this.store.save({
        ...attempt,
        status: this.closed || (retryable && attempt.attempts < 5) ? 'pending' : 'failed',
        nextAttemptAt: Date.now() + Math.max(1000 * 2 ** (attempt.attempts - 1), retryAfter),
        error
      })
    }
  }
}
