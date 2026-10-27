import { setTimeout as delay } from 'node:timers/promises'

import { EventType, type ExecutionOptions, type RunAgentInput } from '@keundal/core'
import type { LLMService } from '@keundal/llm'
import {
  SubtitleTranslationService,
  type SubtitleSegment,
  type TranslateSubtitlesRequest,
  type TranslateSubtitlesResult
} from '@keundal/media'
import type { Context } from 'cordis'

import { parseTranslatedLines } from './parse.js'

export interface SubtitleTranslateConfig {
  readonly batchSize?: number
  readonly concurrency?: number
  /** 실패한 요청을 다시 보내는 횟수입니다. */
  readonly retries?: number
  /** 재시도 전에 기다리는 시간입니다. 시도마다 늘어납니다. */
  readonly retryDelayMs?: number
}

const SYSTEM_PROMPT =
  'You translate subtitle lines. Reply with a JSON array of strings and nothing else. ' +
  'Keep the same number of items and the same order. Do not merge or split lines. ' +
  'Keep numbers, names, and units as written unless the target language requires otherwise.'

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function limitValue(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/429|rate limit|overloaded|too many requests|timeout|temporar|ECONN|socket/i.test(message)) return true
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && (status === 429 || status >= 500)
}

async function pool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      await worker(items[index]!)
    }
  })
  await Promise.all(runners)
}

function batches(indexes: readonly number[], size: number): number[][] {
  const result: number[][] = []
  for (let index = 0; index < indexes.length; index += size) {
    result.push(indexes.slice(index, index + size))
  }
  return result
}

/** `llm`으로 자막 트랙을 배치 번역합니다. 실패한 배치는 원문을 유지합니다. */
export class LlmSubtitleTranslationService extends SubtitleTranslationService {
  private readonly llm: LLMService
  private readonly batchSize: number
  private readonly concurrency: number
  private readonly retries: number
  private readonly retryDelayMs: number
  private readonly lifetime = new globalThis.AbortController()

  constructor(ctx: Context, config: SubtitleTranslateConfig = {}) {
    super(ctx)
    this.llm = ctx.llm
    this.batchSize = limitValue(config.batchSize, 8, 'batchSize', 1, 200)
    this.concurrency = limitValue(config.concurrency, 2, 'concurrency', 1, 16)
    this.retries = limitValue(config.retries, 2, 'retries', 0, 10)
    this.retryDelayMs = limitValue(config.retryDelayMs, 500, 'retryDelayMs', 0, 60_000)
    ctx.fiber.effect(() => () => this.lifetime.abort())
  }

  async translate(
    request: TranslateSubtitlesRequest,
    options: ExecutionOptions = {}
  ): Promise<TranslateSubtitlesResult> {
    options = {
      ...options,
      signal: globalThis.AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])])
    }
    options.signal?.throwIfAborted()
    if (!request || typeof request !== 'object') throw new TypeError('request is required')
    const track = request.track
    if (!track || !Array.isArray(track.segments)) throw new TypeError('track.segments must be an array')
    const targetLanguage = requireText(request.targetLanguage, 'targetLanguage')
    const model = requireText(request.model, 'model')
    const batchSize = limitValue(request.batchSize, this.batchSize, 'batchSize', 1, 200)
    const concurrency = limitValue(request.concurrency, this.concurrency, 'concurrency', 1, 16)
    const context = request.context ?? 'window'
    if (context !== 'window' && context !== 'full') throw new TypeError('context must be window or full')

    const indexes = track.segments
      .map((segment, index) => (segment.text.trim().length > 0 ? index : -1))
      .filter((index) => index >= 0)
    const texts = track.segments.map((segment) => segment.text)
    const fullTranscript = context === 'full' ? track.segments.map((segment) => segment.text).join('\n') : null
    let failed = 0
    let requests = 0

    await pool(batches(indexes, batchSize), concurrency, async (batch) => {
      const lines = batch.map((index) => track.segments[index]!.text)
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        options.signal?.throwIfAborted()
        try {
          requests += 1
          const answer = await this.complete({
            model,
            targetLanguage,
            lines,
            options,
            title: request.title ?? null,
            prompt: request.prompt ?? null,
            previous: previousLines(track.segments, batch[0]!),
            transcript: fullTranscript,
            reasoning: request.reasoning
          })
          options.signal?.throwIfAborted()
          const translated = parseTranslatedLines(answer, lines.length)
          batch.forEach((index, position) => {
            const value = translated[position]
            if (value !== undefined && value.length > 0) texts[index] = value!
          })
          return
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (attempt >= this.retries || !retryable(error)) {
            failed += lines.length
            return
          }
          await delay(this.retryDelayMs * (attempt + 1), undefined, { signal: options.signal })
        }
      }
    })

    options.signal?.throwIfAborted()
    return {
      track: {
        id: `translation:${targetLanguage}`,
        kind: 'translation',
        language: targetLanguage,
        segments: track.segments.map((segment, index) => ({ ...segment, text: texts[index]! }))
      },
      failed,
      skipped: track.segments.length - indexes.length,
      requests
    }
  }

  private async complete(input: {
    readonly model: string
    readonly targetLanguage: string
    readonly lines: readonly string[]
    readonly previous: readonly string[]
    readonly transcript: string | null
    readonly title: string | null
    readonly prompt: string | null
    readonly reasoning?: TranslateSubtitlesRequest['reasoning']
    readonly options: ExecutionOptions
  }): Promise<string> {
    const characters = input.lines.reduce((total, line) => total + line.length, 0)
    const maxOutputTokens = Math.min(8_192, Math.max(512, characters * 2))
    const request: RunAgentInput = {
      threadId: globalThis.crypto.randomUUID(),
      runId: globalThis.crypto.randomUUID(),
      state: {},
      tools: [],
      context: [],
      messages: [
        { id: globalThis.crypto.randomUUID(), role: 'system', content: SYSTEM_PROMPT },
        {
          id: globalThis.crypto.randomUUID(),
          role: 'user',
          content: JSON.stringify({
            targetLanguage: input.targetLanguage,
            title: input.title,
            instructions: input.prompt,
            previousLines: input.previous,
            transcript: input.transcript,
            lines: input.lines
          })
        }
      ]
    }
    let text = ''
    for await (const event of this.llm.stream(
      {
        model: input.model,
        maxOutputTokens,
        input: request,
        ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning })
      },
      input.options
    )) {
      input.options.signal?.throwIfAborted()
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) text += event.delta
    }
    return text
  }
}

function previousLines(segments: readonly SubtitleSegment[], first: number): readonly string[] {
  return segments
    .slice(Math.max(0, first - 3), first)
    .map((segment) => segment.text)
    .filter((text) => text.trim().length > 0)
}
