import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import { type ExecutionOptions } from '@keundal/core'
import {
  fetchWithStreamLimit,
  StreamBudget,
  LLMService,
  type LLMEvent,
  type LLMModel,
  type LLMRequest
} from '@keundal/llm'
import { llmUsageEvent } from '@keundal/trace'
import type { Context } from 'cordis'

import { GeminiLLMConfigSchema, parseConfig, type GeminiLLMConfig } from './config.js'
import { ContentsEvents } from './events.js'
import { createCountInput, createInput } from './request.js'

export const metadata = {
  name: { en: 'Gemini', ko: 'Gemini' },
  description: { en: 'Connects models through the Google Gemini API.', ko: 'Google Gemini API로 모델에 연결합니다.' }
}

export { GeminiLLMConfigSchema, type GeminiLLMConfig } from './config.js'
export { listGeminiModels } from './models.js'

export class GeminiLLMService extends LLMService {
  private readonly client: GoogleGenAI
  private readonly models: Readonly<Record<string, LLMModel>>
  private readonly active = new Set<AbortController>()
  private closed = false

  constructor(ctx: Context, config: GeminiLLMConfig) {
    super(ctx)
    const parsed = parseConfig(config)
    this.models = parsed.models
    const noAuth = parsed.apiKey === ''
    this.client = new GoogleGenAI({
      // The SDK requires a key; the transport removes this sentinel before sending.
      apiKey: noAuth ? 'keundal-no-auth' : parsed.apiKey,
      ...(noAuth ? { vertexai: false } : {}),
      httpOptions: {
        baseUrl: parsed.baseURL,
        headers: parsed.headers,
        fetch: fetchWithStreamLimit,
        ...(noAuth
          ? {
              fetch: (url, init) => {
                const headers = new globalThis.Headers(init?.headers)
                if (!Object.keys(parsed.headers ?? {}).some((name) => name.toLowerCase() === 'x-goog-api-key')) {
                  headers.delete('x-goog-api-key')
                }
                return fetchWithStreamLimit(url, { ...init, headers })
              }
            }
          : {})
      }
    })
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const controller of this.active) controller.abort(new Error('Gemini LLM service disposed'))
    })
  }

  async getModel(model: string, options?: ExecutionOptions): Promise<LLMModel> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    return { ...this.model(model) }
  }

  async countTokens(request: LLMRequest, options?: ExecutionOptions): Promise<number> {
    const operation = this.operation(options)
    try {
      operation.signal.throwIfAborted()
      this.validateRequest(request)
      const { contents } = createCountInput(request)
      const result = await this.client.models.countTokens({
        model: request.model,
        contents,
        config: { abortSignal: operation.signal }
      })
      operation.signal.throwIfAborted()
      if (!Number.isSafeInteger(result.totalTokens) || result.totalTokens! < 0) {
        throw new Error('invalid Gemini input token count', { cause: result })
      }
      return result.totalTokens!
    } catch (error) {
      operation.signal.throwIfAborted()
      throw error
    } finally {
      operation.cleanup()
    }
  }

  stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterableIterator<LLMEvent> {
    const operation = this.operation(options)
    const stop = () => {
      operation.controller.abort(new Error('Gemini LLM stream stopped'))
      operation.cleanup()
    }
    const iterator = this.execute(request, operation.signal, stop)
    return {
      next: () => iterator.next(),
      return: async () => {
        stop()
        return iterator.return(undefined)
      },
      throw: async (error?: unknown) => {
        stop()
        return iterator.throw(error)
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }

  private async *execute(
    request: LLMRequest,
    signal: AbortSignal,
    cleanup: () => void
  ): AsyncGenerator<LLMEvent, void, unknown> {
    let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined
    try {
      signal.throwIfAborted()
      this.validateRequest(request)
      const { systemInstruction, contents, tools } = createInput(request)
      const stream = await this.client.models.generateContentStream({
        model: request.model,
        contents,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(tools ? { tools } : {}),
          maxOutputTokens: request.maxOutputTokens,
          thinkingConfig: {
            includeThoughts: request.reasoning !== false,
            ...(request.reasoning === undefined
              ? {}
              : request.model.startsWith('gemini-3')
                ? {
                    thinkingLevel: request.reasoning
                      ? request.reasoning === 'low'
                        ? ThinkingLevel.LOW
                        : request.reasoning === 'medium'
                          ? ThinkingLevel.MEDIUM
                          : ThinkingLevel.HIGH
                      : request.model.includes('flash')
                        ? ThinkingLevel.MINIMAL
                        : ThinkingLevel.LOW
                  }
                : {
                    thinkingBudget: request.reasoning
                      ? Math.min(
                          24576,
                          Math.max(
                            1,
                            Math.floor(
                              request.maxOutputTokens *
                                (request.reasoning === 'low' ? 0.25 : request.reasoning === 'high' ? 0.75 : 0.5)
                            )
                          )
                        )
                      : 0
                  })
          },
          abortSignal: signal
        }
      })
      const budget = new StreamBudget()
      const events = new ContentsEvents()
      let candidateTokens: number | undefined
      let thoughtsTokens: number | undefined
      for await (const chunk of stream) {
        signal.throwIfAborted()
        budget.accept(chunk)
        const metadata = chunk.usageMetadata
        if (metadata) {
          const inputTokens = safeTokenCount(metadata.promptTokenCount)
          const candidateCount = safeTokenCount(metadata.candidatesTokenCount)
          const thoughtsCount = safeTokenCount(metadata.thoughtsTokenCount)
          if (candidateCount !== undefined) candidateTokens = candidateCount
          if (thoughtsCount !== undefined) thoughtsTokens = thoughtsCount
          const outputTokens = candidateTokens === undefined ? undefined : candidateTokens + (thoughtsTokens ?? 0)
          const cacheReadTokens = safeTokenCount(metadata.cachedContentTokenCount)
          usage = {
            ...usage,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens })
          }
        }
        if (metadata && usage && Object.keys(usage).length) yield llmUsageEvent({ source: 'provider', ...usage })
        for (const mapped of events.convert(chunk)) {
          signal.throwIfAborted()
          yield mapped
        }
      }
      signal.throwIfAborted()
      events.assertFinished()
    } catch (error) {
      signal.throwIfAborted()
      throw error
    } finally {
      cleanup()
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Gemini LLM service disposed')
  }

  private model(name: string): LLMModel {
    if (!Object.hasOwn(this.models, name)) throw new Error(`Gemini model limits are not configured: ${name}`)
    return this.models[name]
  }

  private validateRequest(request: LLMRequest): void {
    const model = this.model(request.model)
    if (
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens <= 0 ||
      request.maxOutputTokens > model.maxOutputTokens ||
      request.maxOutputTokens >= model.contextWindow
    ) {
      throw new Error('requested output budget exceeds the configured Gemini model limits')
    }
  }

  private operation(options?: ExecutionOptions) {
    this.assertOpen()
    const controller = new globalThis.AbortController()
    const external = options?.signal
    const abort = () => controller.abort(external?.reason)
    const cleanup = () => {
      external?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', cleanup)
      this.active.delete(controller)
    }
    this.active.add(controller)
    controller.signal.addEventListener('abort', cleanup, { once: true })
    if (external?.aborted) abort()
    else external?.addEventListener('abort', abort, { once: true })
    return { controller, signal: controller.signal, cleanup }
  }
}

export const geminiLLMPlugin = Object.assign(
  function geminiLLMPlugin(ctx: Context, config: GeminiLLMConfig) {
    new GeminiLLMService(ctx, config)
  },
  { Config: GeminiLLMConfigSchema }
)

function safeTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}
export default geminiLLMPlugin
