import { Service, type Context } from 'cordis'

export interface Notification {
  /** Stable across retries and host restarts; receivers must deduplicate by this ID. */
  id: string
  type: 'automation.completed' | 'automation.failed' | 'automation.interrupted'
  automationId: string
  attemptId: string
  runId: string
  taskId?: string
  content: string
  error?: string
  createdAt: number
}

export interface NotificationDelivery {
  notification: Notification
  /** Non-secret destination identity, not a URL or credential. */
  target: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  nextAttemptAt: number
  /** Sanitized failure classification; never includes response bodies or credentials. */
  error?: string
}

/** Single executor per database, like TaskStore and AutomationStore. */
export abstract class NotificationStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'notificationStore')
  }

  /** Atomically inserts (target, notification.id), without replacing an existing delivery. */
  abstract claim(delivery: NotificationDelivery): Promise<boolean>
  abstract save(delivery: NotificationDelivery): Promise<void>
  abstract list(target: string): Promise<NotificationDelivery[]>
}

export abstract class NotificationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'notification')
  }

  /** Durably queues a result; does not wait for network delivery. Repeated IDs are ignored. */
  abstract notify(notification: Notification): Promise<void>
  /** Stops sending and preserves pending deliveries for the next host. */
  abstract dispose(): Promise<void>
}

declare module 'cordis' {
  interface Context {
    readonly notification: NotificationService
    readonly notificationStore: NotificationStore
  }
}
