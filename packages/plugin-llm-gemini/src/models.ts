import type { ExecutionOptions } from '@keundal/core'
import type { LLMModelInfo } from '@keundal/llm'
import { MODEL_CATALOG_LIMITS, ModelCatalogBudget, readModelCatalogCapabilities } from '@keundal/llm'
import { z } from 'zod'

import type { GeminiLLMConfig } from './config.js'

/** 생성 한도 설정 없이 generateContent 모델 목록을 모든 페이지에서 조회합니다. */
export async function listGeminiModels(
  config: Omit<GeminiLLMConfig, 'models' | 'apiKey'> & { readonly apiKey: string },
  options: ExecutionOptions = {}
): Promise<LLMModelInfo[]> {
  const budget = new ModelCatalogBudget()
  const configuredURL = config.baseURL ?? 'https://generativelanguage.googleapis.com'
  let end = configuredURL.length
  while (configuredURL[end - 1] === '/') end--
  const baseURL = configuredURL.slice(0, end)
  const models = new Map<string, LLMModelInfo>()
  const cursors = new Set<string>()
  let cursor = ''
  do {
    options.signal?.throwIfAborted()
    const url = new globalThis.URL(`${baseURL}/v1beta/models`)
    if (cursor) url.searchParams.set('pageToken', cursor)
    budget.beginPage()
    const response = await globalThis.fetch(url, {
      headers: { ...(config.apiKey ? { 'x-goog-api-key': config.apiKey } : {}), ...config.headers },
      signal: options.signal,
      cache: 'no-store',
      credentials: 'omit'
    })
    if (!response.ok) {
      if (response.status !== 400) await response.body?.cancel()
      throw {
        status: response.status,
        error: response.status === 400 ? await budget.readJSON(response).catch(() => undefined) : undefined
      }
    }
    const page = z
      .object({
        models: z.array(
          z.object({
            name: z.string().min(1).max(MODEL_CATALOG_LIMITS.fieldLength),
            displayName: z.string().max(MODEL_CATALOG_LIMITS.fieldLength).optional(),
            supportedGenerationMethods: z.array(z.string()).optional(),
            inputTokenLimit: z.number().positive().optional(),
            outputTokenLimit: z.number().positive().optional(),
            capabilities: z.unknown().transform(readModelCatalogCapabilities).optional()
          })
        ),
        nextPageToken: z.string().max(MODEL_CATALOG_LIMITS.cursorLength).optional()
      })
      .parse(await budget.readJSON(response))
    budget.acceptEntries(page.models.length)
    for (const model of page.models) {
      if (!model.supportedGenerationMethods?.includes('generateContent')) continue
      const id = model.name.replace(/^models\//, '')
      models.set(id, {
        id,
        name: model.displayName || id,
        contextWindow: model.inputTokenLimit,
        maxOutputTokens: model.outputTokenLimit,
        capabilities: model.capabilities
      })
    }
    cursor = page.nextPageToken || ''
    if (cursor && cursors.has(cursor)) throw new Error('Repeated models cursor')
    cursors.add(cursor)
  } while (cursor)
  options.signal?.throwIfAborted()
  return [...models.values()]
}
