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
import OpenAI from 'openai'

import { OpenAIChatLLMConfigSchema, parseConfig, type OpenAIChatLLMConfig } from './config.js'
import { CompletionEvents } from './events.js'
import { createInput } from './request.js'

export const metadata = {
  name: { en: 'OpenAI Chat Completions', ko: 'OpenAI Chat Completions' },
  description: {
    en: 'Connects models through the OpenAI-compatible Chat Completions API.',
    ko: 'OpenAI 호환 Chat Completions API로 모델에 연결합니다.'
  }
}

export { OpenAIChatLLMConfigSchema, type OpenAIChatLLMConfig } from './config.js'
export { listOpenAIChatModels } from './models.js'

export class OpenAIChatLLMService extends LLMService {
  private readonly client: OpenAI
  private readonly models: Readonly<Record<string, LLMModel>>
  private readonly active = new Set<AbortController>()
  private closed = false

  constructor(ctx: Context, config: OpenAIChatLLMConfig) {
    super(ctx)
    const parsed = parseConfig(config)
    this.models = parsed.models
    const noAuth = parsed.apiKey === ''
    this.client = new OpenAI({
      // The SDK requires a key; null headers below omit the sentinel from requests.
      apiKey: noAuth ? 'keundal-no-auth' : parsed.apiKey,
      baseURL: parsed.baseURL,
      // Explicit empty keys opt out of SDK authentication, including environment defaults.
      ...(noAuth ? { adminAPIKey: null } : {}),
      defaultHeaders: { ...(noAuth ? { authorization: null, 'api-key': null } : {}), ...parsed.headers },
      dangerouslyAllowBrowser: parsed.dangerouslyAllowBrowser,
      fetch: fetchWithStreamLimit,
      maxRetries: 0
    })
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const controller of this.active) controller.abort(new Error('OpenAI Chat Completions LLM service disposed'))
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
      const input = createInput(request)
      // Chat Completions에는 입력 토큰 계산 엔드포인트가 없습니다. 요청 본문의 UTF-8 바이트 수로
      // 보수적으로 추정하며, 정확한 토크나이저 값이 아니므로 텍스트 이외의 입력은 실제 비용과 다릅니다.
      return new globalThis.TextEncoder().encode(JSON.stringify(input)).length
    } catch (error) {
      operation.signal.throwIfAborted()
      throw error
    } finally {
      operation.cleanup()
    }
  }

  stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterableIterator<LLMEvent> {
    const operation = this.operation(options)
    const iterator = this.execute(request, operation.signal, operation.cleanup)
    const stop = () => {
      operation.controller.abort(new Error('OpenAI Chat Completions LLM stream stopped'))
      operation.cleanup()
    }
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
    try {
      signal.throwIfAborted()
      this.validateRequest(request)
      const stream = await this.client.chat.completions.create(
        {
          ...createInput(request),
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: request.maxOutputTokens
        },
        { signal }
      )
      const budget = new StreamBudget()
      const events = new CompletionEvents()
      try {
        for await (const chunk of stream) {
          signal.throwIfAborted()
          budget.accept(chunk)
          if (chunk.usage) {
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens
            yield llmUsageEvent({
              source: 'provider',
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              ...(Number.isSafeInteger(cached) && cached! >= 0 ? { cacheReadTokens: cached } : {})
            })
          }
          for (const mapped of events.convert(chunk)) {
            signal.throwIfAborted()
            yield mapped
          }
        }
        signal.throwIfAborted()
        for (const event of events.close()) {
          signal.throwIfAborted()
          yield event
        }
      } finally {
        stream.controller.abort()
      }
    } catch (error) {
      signal.throwIfAborted()
      throw error
    } finally {
      cleanup()
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('OpenAI Chat Completions LLM service disposed')
  }

  private model(name: string): LLMModel {
    if (!Object.hasOwn(this.models, name)) throw new Error(`OpenAI model limits are not configured: ${name}`)
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
      throw new Error('requested output budget exceeds the configured OpenAI model limits')
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

export const openaiChatLLMPlugin = Object.assign(
  function openaiChatLLMPlugin(ctx: Context, config: OpenAIChatLLMConfig) {
    new OpenAIChatLLMService(ctx, config)
  },
  { Config: OpenAIChatLLMConfigSchema }
)

export default openaiChatLLMPlugin
