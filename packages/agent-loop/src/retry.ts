import { SummaryCompactionController } from '@keundal/compaction-summary/controller'
import { EventType } from '@keundal/core'
import { isTransientLLMError, llmRetryAfterMs, type LLMEvent, type LLMRequest, type LLMService } from '@keundal/llm'
import { LLM_USAGE_EVENT, TRACE_EVENT } from '@keundal/trace'
import type { TraceRecorder } from '@keundal/trace/recording'

import type { AgentConfig } from './config.js'

export interface ModelRetryConfig {
  readonly maxRetries?: number
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
}

export function parseModelRetry(value: unknown): ModelRetryConfig | false {
  if (value === false) return false
  if (value === undefined) return { maxRetries: 2, initialDelayMs: 250, maxDelayMs: 4000 }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('retry must be an object or false')
  const source = value as Record<string, unknown>
  if (Object.keys(source).some((key) => !['maxRetries', 'initialDelayMs', 'maxDelayMs'].includes(key)))
    throw new Error('unknown retry option')
  const result = {
    maxRetries: source.maxRetries === undefined ? 2 : source.maxRetries,
    initialDelayMs: source.initialDelayMs === undefined ? 250 : source.initialDelayMs,
    maxDelayMs: source.maxDelayMs === undefined ? 4000 : source.maxDelayMs
  }
  for (const [key, limit] of [
    ['maxRetries', 5],
    ['initialDelayMs', 60_000],
    ['maxDelayMs', 60_000]
  ] as const) {
    const count = result[key]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > limit)
      throw new Error(`retry.${key} must be an integer between 0 and ${limit}`)
  }
  if ((result.initialDelayMs as number) > (result.maxDelayMs as number))
    throw new Error('retry.initialDelayMs exceeds maxDelayMs')
  return result as Required<ModelRetryConfig>
}

export function parseFallbackModels(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    Array.from(value).some((item) => typeof item !== 'string' || !item.trim())
  )
    throw new Error('fallbackModels must contain at most 8 non-empty model IDs')
  const models = value.map((item: string) => item.trim())
  if (new Set(models).size !== models.length) throw new Error('fallbackModels must not contain duplicates')
  return models
}

function retryDelay(error: unknown, attempt: number, policy: Required<ModelRetryConfig>): number {
  return (
    llmRetryAfterMs(error) ??
    Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** attempt) * (0.5 + Math.random() * 0.5)
  )
}

async function wait(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      globalThis.clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delay)
    signal.addEventListener('abort', abort, { once: true })
  })
  signal.throwIfAborted()
}

/** Retries one model request, never the generation or its completed tools. */
export async function* streamWithModelRecovery(
  llm: Pick<LLMService, 'getModel' | 'countTokens' | 'stream'>,
  request: LLMRequest,
  config: AgentConfig,
  primary: SummaryCompactionController,
  maxInputTokens: number,
  signal: AbortSignal,
  trace: TraceRecorder,
  selectModel: (model: string) => void
): AsyncGenerator<LLMEvent> {
  const parsed = parseModelRetry(config.retry)
  const policy: Required<ModelRetryConfig> = { maxRetries: 0, initialDelayMs: 250, maxDelayMs: 4000, ...parsed }
  let failure: unknown
  for (const model of [request.model, ...(config.fallbackModels ?? []).filter((model) => model !== request.model)]) {
    signal.throwIfAborted()
    const candidate = { ...request, model }
    const fallback = model !== request.model
    const compaction = fallback ? new SummaryCompactionController(llm, { ...config, model }) : primary
    let inputBudget = maxInputTokens
    try {
      if (fallback) {
        // Opaque reasoning/tool signatures can be model-bound; capability flags cannot prove replay safety.
        if (
          request.input.messages.some(
            (message) =>
              ('encryptedValue' in message && !!message.encryptedValue) ||
              (message.role === 'assistant' && message.toolCalls?.some((call) => !!call.encryptedValue))
          )
        )
          continue
        const limits = await llm.getModel(model, { signal }).catch(() => {
          signal.throwIfAborted()
          return undefined
        })
        signal.throwIfAborted()
        if (!limits) continue
        const capabilities = limits.capabilities
        const needsTools =
          request.input.tools.length > 0 ||
          request.input.messages.some(
            (message) => message.role === 'tool' || (message.role === 'assistant' && !!message.toolCalls?.length)
          )
        if (needsTools && capabilities?.tools !== true) continue
        if (request.reasoning !== undefined && !capabilities?.reasoning?.includes(request.reasoning)) continue
        if (request.webSearch && capabilities?.webSearch !== true) continue
        inputBudget = limits.contextWindow - request.maxOutputTokens - (compaction.policy.reserveTokens ?? 0)
        if (!Number.isSafeInteger(inputBudget) || inputBudget <= 0 || request.maxOutputTokens > limits.maxOutputTokens)
          continue
        const tokens = await llm.countTokens(candidate, { signal })
        signal.throwIfAborted()
        // Do not discard history or reduce output/reasoning requirements to make a fallback fit.
        if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > inputBudget) continue
      }
      for (let attempt = 0; ; attempt++) {
        let emitted = false
        try {
          for await (const event of compaction.streamWithRetry(candidate, inputBudget, signal, trace)) {
            if (!(event.type === EventType.CUSTOM && (event.name === TRACE_EVENT || event.name === LLM_USAGE_EVENT)))
              emitted = true
            yield event
          }
          selectModel(model)
          return
        } catch (error) {
          signal.throwIfAborted()
          if (emitted || !isTransientLLMError(error)) throw error
          failure = error
          if (attempt >= policy.maxRetries) break
          const delay = retryDelay(error, attempt, policy)
          // A long server cooldown must not become an unbounded wait or an early retry.
          if (delay > policy.maxDelayMs) break
          await wait(delay, signal)
        }
      }
    } finally {
      if (fallback) compaction.dispose()
    }
  }
  throw failure
}
