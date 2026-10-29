import { EventType, parseAGUIEvent, type ExecutionOptions } from '@keundal/core'
import {
  LLMService,
  parseModelCapabilities,
  type LLMEvent,
  type LLMModel,
  type LLMModelInfo,
  type LLMRequest
} from '@keundal/llm'
import type { Context } from 'cordis'
import { z } from 'zod'

export const metadata = {
  name: { en: 'Mock LLM', ko: 'LLM 목업' },
  description: {
    en: 'Tests text, tool calls, errors and cancellation without an API key or network requests.',
    ko: 'API 키나 네트워크 요청 없이 텍스트, 도구 호출, 오류와 취소를 시험합니다.'
  }
}

const modelSchema = z
  .object({
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    capabilities: z.unknown().transform(parseModelCapabilities).optional()
  })
  .refine((model) => model.maxOutputTokens < model.contextWindow, 'Output limit must be below context window')

const responseSchema = z
  .object({
    text: z.string().optional(),
    events: z
      .array(
        z.custom<LLMEvent>((value) => {
          try {
            const event = parseAGUIEvent(value)
            return (
              event.type !== EventType.RUN_STARTED &&
              event.type !== EventType.RUN_FINISHED &&
              event.type !== EventType.RUN_ERROR
            )
          } catch {
            return false
          }
        })
      )
      .readonly()
      .optional(),
    error: z.string().min(1).optional(),
    delayMs: z.number().int().min(0).max(2_147_483_647).optional()
  })
  .refine(
    (response) =>
      !(response.text !== undefined && response.events !== undefined) &&
      (response.text !== undefined || response.events !== undefined || response.error !== undefined),
    'Specify text, events or an error; text and events cannot be combined'
  )

export const MockLLMConfigSchema = z.object({
  models: z
    .record(z.string().min(1), modelSchema)
    .refine((models) => Object.keys(models).length > 0)
    .optional(),
  responses: z.array(responseSchema).readonly().optional(),
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  delayMs: z.number().int().min(0).max(2_147_483_647).optional()
})

export type MockLLMConfig = z.input<typeof MockLLMConfigSchema>
export type MockResponse = z.input<typeof responseSchema>

export async function listMockModels(
  _config: unknown = {},
  options?: ExecutionOptions
): Promise<(LLMModelInfo & LLMModel)[]> {
  options?.signal?.throwIfAborted()
  return [
    { id: 'mock-text', name: 'Mock · Text' },
    { id: 'mock-tool', name: 'Mock · Tool (JSON: name, arguments)' },
    { id: 'mock-error', name: 'Mock · Error' },
    { id: 'mock-slow', name: 'Mock · Slow stream' }
  ].map((model) => ({
    ...model,
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    capabilities: { tools: model.id === 'mock-tool', reasoning: [], webSearch: false }
  }))
}

export class MockLLMService extends LLMService {
  readonly requests: LLMRequest[] = []
  private readonly config: z.output<typeof MockLLMConfigSchema>
  private readonly disposed = new globalThis.AbortController()

  constructor(ctx: Context, config: MockLLMConfig = {}) {
    super(ctx)
    this.config = globalThis.structuredClone(MockLLMConfigSchema.parse(config))
    ctx.fiber.effect(() => () => this.disposed.abort(new Error('Mock LLM service disposed')))
  }

  async getModel(model: string, options?: ExecutionOptions): Promise<LLMModel> {
    const signal = this.signal(options)
    signal.throwIfAborted()
    const limits = this.config.models
      ? Object.hasOwn(this.config.models, model)
        ? this.config.models[model]
        : undefined
      : (await listMockModels()).find((entry) => entry.id === model)
    signal.throwIfAborted()
    if (!limits) throw new Error(`Mock model limits are not configured: ${model}`)
    return globalThis.structuredClone({
      contextWindow: limits.contextWindow,
      maxOutputTokens: limits.maxOutputTokens,
      capabilities: limits.capabilities
    })
  }

  async countTokens(request: LLMRequest, options?: ExecutionOptions) {
    await this.getModel(request.model, options)
    this.signal(options).throwIfAborted()
    // Deliberately deterministic, not a provider tokenizer or a real context-fit guarantee.
    return this.config.inputTokens ?? new globalThis.TextEncoder().encode(JSON.stringify(request.input)).length
  }

  stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterableIterator<LLMEvent> {
    const stopped = new globalThis.AbortController()
    const signal = globalThis.AbortSignal.any([this.signal(options), stopped.signal])
    const iterator = this.execute(request, signal)
    return {
      next: () => iterator.next(),
      return: async () => {
        stopped.abort(new Error('Mock LLM stream stopped'))
        return iterator.return(undefined)
      },
      throw: async (error?: unknown) => {
        stopped.abort(error)
        return iterator.throw(error)
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }

  private signal(options?: ExecutionOptions) {
    return options?.signal ? globalThis.AbortSignal.any([this.disposed.signal, options.signal]) : this.disposed.signal
  }

  private async *execute(request: LLMRequest, signal: AbortSignal): AsyncGenerator<LLMEvent, void, unknown> {
    signal.throwIfAborted()
    const model = await this.getModel(request.model, { signal })
    if (
      !Number.isSafeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens <= 0 ||
      request.maxOutputTokens > model.maxOutputTokens ||
      request.maxOutputTokens >= model.contextWindow
    )
      throw new Error('Requested output budget exceeds the configured Mock model limits')
    signal.throwIfAborted()
    const index = this.requests.length
    this.requests.push(globalThis.structuredClone(request))
    const response = this.config.responses === undefined ? this.demo(request) : this.config.responses[index]
    if (!response) throw new Error(`Mock LLM responses exhausted at call ${index + 1}`)
    const events = response.events ?? (response.text === undefined ? [] : this.textEvents(response.text))
    const delayMs = response.delayMs ?? this.config.delayMs ?? 0
    for (const event of events) {
      await this.wait(delayMs, signal)
      signal.throwIfAborted()
      yield globalThis.structuredClone(event)
    }
    if (response.error !== undefined) {
      await this.wait(delayMs, signal)
      signal.throwIfAborted()
      throw new Error(response.error)
    }
  }

  private demo(request: LLMRequest): MockResponse {
    if (request.model === 'mock-error') return { error: 'Mock LLM: simulated provider error' }
    const lastUser = request.input.messages.findLastIndex((message) => message.role === 'user')
    const message = request.input.messages[lastUser]
    const content = message?.role === 'user' ? message.content : ''
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
    if (request.model === 'mock-tool') {
      const result = request.input.messages.slice(lastUser + 1).findLast((message) => message.role === 'tool')
      if (result)
        return {
          text: `Mock tool result: ${typeof result.content === 'string' ? result.content : JSON.stringify(result.content)}`
        }
      try {
        const call = z
          .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })
          .parse(JSON.parse(text))
        if (!request.input.tools.some((tool) => tool.name === call.name)) throw new Error('Tool not available')
        const toolCallId = globalThis.crypto.randomUUID()
        return {
          events: [
            { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: call.name },
            { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(call.arguments) },
            { type: EventType.TOOL_CALL_END, toolCallId }
          ]
        }
      } catch {
        return {
          text: 'Mock tool: send {"name":"available_tool_name","arguments":{}}. Only explicitly named, available tools are called.'
        }
      }
    }
    return {
      text: `Mock LLM: ${text || 'Hello! No external model was called.'}`,
      delayMs: this.config.delayMs ?? (request.model === 'mock-slow' ? 150 : 30)
    }
  }

  private textEvents(text: string): LLMEvent[] {
    const messageId = globalThis.crypto.randomUUID()
    const characters = Array.from(text)
    const events: LLMEvent[] = [{ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }]
    for (let index = 0; index < characters.length; index += 12)
      events.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: characters.slice(index, index + 12).join('')
      })
    events.push({ type: EventType.TEXT_MESSAGE_END, messageId })
    return events
  }

  private async wait(delayMs: number, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!delayMs) return
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        globalThis.clearTimeout(timer)
        reject(signal.reason)
      }
      const timer = globalThis.setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, delayMs)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}

export const mockLLMPlugin = Object.assign(
  function mockLLMPlugin(ctx: Context, config: MockLLMConfig = {}) {
    new MockLLMService(ctx, config)
  },
  { Config: MockLLMConfigSchema }
)

export default mockLLMPlugin
