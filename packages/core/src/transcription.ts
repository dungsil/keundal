import { Service, type Context } from 'cordis'

import type { ExecutionOptions } from './execution.js'

/** Serializable browser connection configuration. Never contains a server API key. */
export interface TranscriptionSession {
  readonly clientSecret: string
  /** Unix timestamp in seconds; limits new connections, not session duration. */
  readonly expiresAt: number
  readonly url: string
  readonly protocols: readonly string[]
  readonly audio: { readonly format: 'pcm16'; readonly sampleRate: 24000; readonly channels: 1 }
}

export interface TranscriptionRequest {
  readonly model: string
  readonly expiresAfterSeconds?: number
}

export abstract class TranscriptionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'transcription')
  }

  abstract createSession(request: TranscriptionRequest, options?: ExecutionOptions): Promise<TranscriptionSession>
}
