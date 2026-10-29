import type { ExecutionOptions } from '@keundal/core'

import type { LLMModelInfo } from './llm.js'
import { MODEL_CATALOG_LIMITS, ModelCatalogBudget } from './model-catalog.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function price(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Public catalog only: no provider credentials or endpoint URLs are sent to models.dev. */
export async function listModelsDevModels(provider: string, options: ExecutionOptions = {}): Promise<LLMModelInfo[]> {
  options.signal?.throwIfAborted()
  const response = await globalThis.fetch('https://models.dev/api.json', {
    signal: options.signal,
    credentials: 'omit',
    cache: 'no-cache'
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`models.dev request failed (HTTP ${response.status})`)
  }
  // The complete public catalog is larger than a single provider's discovery response.
  const budget = new ModelCatalogBudget({
    ...MODEL_CATALOG_LIMITS,
    pageBytes: 16 * 1024 * 1024,
    bytes: 16 * 1024 * 1024,
    nodes: 1_048_576
  })
  const catalog = record(await budget.readJSON(response))
  if (!catalog) throw new Error('Invalid models.dev catalog')
  const models = record(record(Object.hasOwn(catalog, provider) ? catalog[provider] : undefined)?.models)
  if (!models) return []
  budget.acceptEntries(Object.keys(models).length)
  const result: LLMModelInfo[] = []
  for (const [id, value] of Object.entries(models)) {
    const model = record(value)
    if (!model || !id || id.length > MODEL_CATALOG_LIMITS.fieldLength) continue
    const limit = record(model.limit)
    const cost = record(model.cost)
    result.push({
      id,
      name:
        typeof model.name === 'string' && model.name && model.name.length <= MODEL_CATALOG_LIMITS.fieldLength
          ? model.name
          : id,
      contextWindow: tokens(limit?.context),
      maxInputTokens: tokens(limit?.input),
      maxOutputTokens: tokens(limit?.output),
      ...(cost
        ? {
            cost: {
              input: price(cost.input),
              output: price(cost.output),
              cacheRead: price(cost.cache_read),
              cacheWrite: price(cost.cache_write)
            }
          }
        : {})
    })
  }
  options.signal?.throwIfAborted()
  return result
}
