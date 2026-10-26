import Anthropic from '@anthropic-ai/sdk'
import {
  fetchWithStreamLimit,
  StreamBudget,
  LLMService,
  llmUsageEvent,
  type ExecutionOptions,
  type LLMEvent,
  type LLMModel,
  type LLMRequest
} from '@keundal/core'
import type { Context } from 'cordis'

import { AnthropicLLMConfigSchema, parseConfig, type AnthropicLLMConfig } from './config.js'
import { MessageEvents } from './events.js'
import { createInput } from './request.js'

export const metadata = {
  name: { en: 'Anthropic', ko: 'Anthropic' },
  description: {
    en: 'Connects Claude models through the Anthropic Messages API.',
    ko: 'Anthropic Messages API로 Claude 모델에 연결합니다.'
  }
}

export { AnthropicLLMConfigSchema, type AnthropicLLMConfig } from './config.js'
export { listAnthropicModels } from './models.js'

export class AnthropicLLMService extends LLMService {
  private readonly client: Anthropic
  private readonly models: Readonly<Record<string, LLMModel>>
  private readonly active = new Set<AbortController>()
  private closed = false

  constructor(ctx: Context, config: AnthropicLLMConfig) {
    super(ctx)
    const parsed = parseConfig(config)
    this.models = parsed.models
    const noAuth = parsed.apiKey === ''
    this.client = new Anthropic({
      apiKey: parsed.apiKey,
      baseURL: parsed.baseURL,
      // Explicit empty keys opt out of SDK authentication, including environment defaults.
      ...(noAuth ? { authToken: null } : {}),
      defaultHeaders: {
        ...(noAuth ? { 'x-api-key': null, authorization: null } : {}),
        ...parsed.headers
      },
      dangerouslyAllowBrowser: parsed.dangerouslyAllowBrowser,
      fetch: fetchWithStreamLimit,
      maxRetries: 0
    })
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const controller of this.active) controller.abort(new Error('Anthropic LLM service disposed'))
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
      const result = await this.client.messages.countTokens(createInput(request), { signal: operation.signal })
      operation.signal.throwIfAborted()
      if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0)
        throw new Error('invalid Anthropic input token count')
      return result.input_tokens
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
      operation.controller.abort(new Error('Anthropic LLM stream stopped'))
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
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let cacheReadTokens: number | undefined
    let cacheWriteTokens: number | undefined
    try {
      this.validateRequest(request)
      const stream = await this.client.messages.create(
        {
          ...createInput(request),
          stream: true,
          max_tokens: request.maxOutputTokens
        },
        { signal }
      )
      const budget = new StreamBudget()
      const events = new MessageEvents()
      try {
        for await (const event of stream) {
          signal.throwIfAborted()
          budget.accept(event)
          if (event.type === 'message_start') {
            const usage = event.message.usage
            inputTokens = safeTokenCount(usage?.input_tokens)
            cacheReadTokens = safeTokenCount(usage?.cache_read_input_tokens)
            cacheWriteTokens = safeTokenCount(usage?.cache_creation_input_tokens)
          } else if (event.type === 'message_delta') {
            outputTokens = safeTokenCount(event.usage?.output_tokens)
          }
          if (event.type === 'message_start' || event.type === 'message_delta') {
            const inputTotal =
              inputTokens === undefined ? undefined : inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
            if (
              inputTotal !== undefined ||
              outputTokens !== undefined ||
              cacheReadTokens !== undefined ||
              cacheWriteTokens !== undefined
            ) {
              yield llmUsageEvent({
                source: 'provider',
                ...(inputTotal === undefined ? {} : { inputTokens: inputTotal }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
                ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
                ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens })
              })
            }
          }
          for (const mapped of events.convert(event)) {
            signal.throwIfAborted()
            yield mapped
          }
          if (event.type === 'message_stop') {
            events.assertFinished()
            return
          }
        }
        signal.throwIfAborted()
        events.assertFinished()
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
    if (this.closed) throw new Error('Anthropic LLM service disposed')
  }

  private model(name: string): LLMModel {
    if (!Object.hasOwn(this.models, name)) throw new Error(`Anthropic model limits are not configured: ${name}`)
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
      throw new Error('requested output budget exceeds the configured Anthropic model limits')
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

export const anthropicLLMPlugin = Object.assign(
  function anthropicLLMPlugin(ctx: Context, config: AnthropicLLMConfig) {
    new AnthropicLLMService(ctx, config)
  },
  { Config: AnthropicLLMConfigSchema }
)

export default anthropicLLMPlugin

function safeTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}
