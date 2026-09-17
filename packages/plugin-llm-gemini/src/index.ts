import { GoogleGenAI } from '@google/genai'
import { LLMService, type ExecutionOptions, type LLMEvent, type LLMModel, type LLMRequest } from '@keundal/core'
import type { Context } from 'cordis'

import { GeminiLLMConfigSchema, parseConfig, type GeminiLLMConfig } from './config.js'
import { ContentsEvents } from './events.js'
import { createCountInput, createInput } from './request.js'

export { GeminiLLMConfigSchema, type GeminiLLMConfig } from './config.js'

export class GeminiLLMService extends LLMService {
  private readonly client: GoogleGenAI
  private readonly models: Readonly<Record<string, LLMModel>>
  private readonly active = new Set<AbortController>()
  private closed = false

  constructor(ctx: Context, config: GeminiLLMConfig) {
    super(ctx)
    const parsed = parseConfig(config)
    this.models = parsed.models
    this.client = new GoogleGenAI({
      ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
      ...(parsed.baseURL ? { httpOptions: { baseUrl: parsed.baseURL } } : {})
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
    const iterator = this.execute(request, operation.signal, operation.cleanup)
    const stop = () => {
      operation.controller.abort(new Error('Gemini LLM stream stopped'))
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
      const { systemInstruction, contents, tools } = createInput(request)
      const stream = await this.client.models.generateContentStream({
        model: request.model,
        contents,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(tools ? { tools } : {}),
          maxOutputTokens: request.maxOutputTokens,
          thinkingConfig: { includeThoughts: true },
          abortSignal: signal
        }
      })
      const events = new ContentsEvents()
      for await (const chunk of stream) {
        signal.throwIfAborted()
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

export default geminiLLMPlugin
