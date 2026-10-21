import {
  fetchWithStreamLimit,
  StreamBudget,
  LLMService,
  type ExecutionOptions,
  type LLMEvent,
  type LLMModel,
  type LLMRequest
} from '@keundal/core'
import type { Context } from 'cordis'
import OpenAI from 'openai'

import { OpenAILLMConfigSchema, parseConfig, type OpenAILLMConfig } from './config.js'
import { ResponseEvents } from './events.js'
import { createInput } from './request.js'

export { OpenAILLMConfigSchema, type OpenAILLMConfig } from './config.js'
export { listOpenAIModels } from './models.js'

export class OpenAILLMService extends LLMService {
  private readonly client: OpenAI
  private readonly models: Readonly<Record<string, LLMModel>>
  private readonly active = new Set<AbortController>()
  private useLocalTokenCount = false
  private closed = false

  constructor(ctx: Context, config: OpenAILLMConfig) {
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
      for (const controller of this.active) controller.abort(new Error('OpenAI LLM service disposed'))
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
      if (!this.useLocalTokenCount) {
        const result = await this.client.responses.inputTokens.count(input, { signal: operation.signal }).catch(() => {
          operation.signal.throwIfAborted()
          // Compatible Responses servers may not implement the token-count endpoint.
          this.useLocalTokenCount = true
        })
        operation.signal.throwIfAborted()
        if (result !== undefined) {
          if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0)
            throw new Error('invalid OpenAI input token count')
          return result.input_tokens
        }
      }
      // A conservative text estimate, not an exact tokenizer or multimodal token count.
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
      operation.controller.abort(new Error('OpenAI LLM stream stopped'))
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
      const stream = await this.client.responses.create(
        {
          ...createInput(request),
          stream: true,
          store: false,
          max_output_tokens: request.maxOutputTokens,
          truncation: 'disabled',
          include: ['reasoning.encrypted_content']
        },
        { signal }
      )
      const budget = new StreamBudget()
      const events = new ResponseEvents()
      try {
        for await (const event of stream) {
          signal.throwIfAborted()
          budget.accept(event)
          if (event.type === 'error') throw new Error(event.message, { cause: event })
          if (event.type === 'response.failed' || event.type === 'response.incomplete') {
            throw new Error(
              event.response.error?.message ??
                `OpenAI response incomplete: ${event.response.incomplete_details?.reason ?? 'unknown'}`,
              { cause: event }
            )
          }
          if (event.type === 'response.completed') {
            events.assertFinished()
            return
          }
          for (const mapped of events.convert(event)) {
            signal.throwIfAborted()
            yield mapped
          }
        }
        signal.throwIfAborted()
        for (const event of events.finish()) {
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
    if (this.closed) throw new Error('OpenAI LLM service disposed')
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

export const openaiLLMPlugin = Object.assign(
  function openaiLLMPlugin(ctx: Context, config: OpenAILLMConfig) {
    new OpenAILLMService(ctx, config)
  },
  { Config: OpenAILLMConfigSchema }
)

export default openaiLLMPlugin
