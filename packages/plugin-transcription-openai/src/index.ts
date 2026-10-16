import {
  TranscriptionService,
  type TranscriptionRequest,
  type TranscriptionSession,
  type ExecutionOptions
} from '@keundal/core'
import type { Context } from 'cordis'
import OpenAI from 'openai'

export interface OpenAITranscriptionConfig {
  apiKey: string
  baseURL?: string
}

export class OpenAITranscriptionService extends TranscriptionService {
  private readonly client: OpenAI
  private readonly url: string
  private readonly active = new Set<AbortController>()
  private closed = false

  constructor(ctx: Context, config: OpenAITranscriptionConfig) {
    super(ctx)
    if (!config.apiKey?.trim()) throw new Error('OpenAI API key is required')
    this.client = new OpenAI({ ...config, maxRetries: 0 })
    const url = new globalThis.URL(`${(config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/realtime`)
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
    url.searchParams.set('intent', 'transcription')
    this.url = url.href
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const controller of this.active) controller.abort(new Error('Transcription service disposed'))
    })
  }

  async createSession(request: TranscriptionRequest, options?: ExecutionOptions): Promise<TranscriptionSession> {
    if (this.closed) throw new Error('Transcription service disposed')
    const seconds = request.expiresAfterSeconds ?? 300
    if (!request.model.trim() || !Number.isInteger(seconds) || seconds < 10 || seconds > 7200)
      throw new Error('Invalid transcription model or credential lifetime')
    const controller = new globalThis.AbortController()
    const abort = () => controller.abort(options?.signal?.reason)
    this.active.add(controller)
    if (options?.signal?.aborted) abort()
    else options?.signal?.addEventListener('abort', abort, { once: true })
    try {
      controller.signal.throwIfAborted()
      const result = await this.client.realtime.clientSecrets.create(
        {
          expires_after: { anchor: 'created_at', seconds },
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: request.model },
                turn_detection: null
              }
            }
          }
        },
        { signal: controller.signal }
      )
      controller.signal.throwIfAborted()
      if (!result.value || !Number.isFinite(result.expires_at)) throw new Error('Invalid transcription credentials')
      return {
        clientSecret: result.value,
        expiresAt: result.expires_at,
        url: this.url,
        protocols: ['realtime', `openai-insecure-api-key.${result.value}`],
        audio: { format: 'pcm16', sampleRate: 24000, channels: 1 }
      }
    } finally {
      options?.signal?.removeEventListener('abort', abort)
      this.active.delete(controller)
    }
  }
}

export function openaiTranscriptionPlugin(ctx: Context, config: OpenAITranscriptionConfig) {
  new OpenAITranscriptionService(ctx, config)
}

export default openaiTranscriptionPlugin
