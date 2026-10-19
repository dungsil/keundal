import type { ExecutionOptions, LLMModelInfo } from '@keundal/core'
import { z } from 'zod'

import type { GeminiLLMConfig } from './config.js'

/** 생성 한도 설정 없이 generateContent 모델 목록을 모든 페이지에서 조회합니다. */
export async function listGeminiModels(
  config: Omit<GeminiLLMConfig, 'models' | 'apiKey'> & { readonly apiKey: string },
  options: ExecutionOptions = {}
): Promise<LLMModelInfo[]> {
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
    const response = await globalThis.fetch(url, {
      headers: { 'x-goog-api-key': config.apiKey, ...config.headers },
      signal: options.signal,
      cache: 'no-store',
      credentials: 'omit'
    })
    if (!response.ok)
      throw {
        status: response.status,
        error: response.status === 400 ? await response.json().catch(() => undefined) : undefined
      }
    const page = z
      .object({
        models: z.array(
          z.object({
            name: z.string().min(1),
            displayName: z.string().optional(),
            supportedGenerationMethods: z.array(z.string()).optional(),
            inputTokenLimit: z.number().positive().optional(),
            outputTokenLimit: z.number().positive().optional()
          })
        ),
        nextPageToken: z.string().optional()
      })
      .parse(await response.json())
    for (const model of page.models) {
      if (!model.supportedGenerationMethods?.includes('generateContent')) continue
      const id = model.name.replace(/^models\//, '')
      models.set(id, {
        id,
        name: model.displayName || id,
        contextWindow: model.inputTokenLimit,
        maxOutputTokens: model.outputTokenLimit
      })
    }
    cursor = page.nextPageToken || ''
    if (cursor && cursors.has(cursor)) throw new Error('Repeated models cursor')
    cursors.add(cursor)
  } while (cursor)
  options.signal?.throwIfAborted()
  return [...models.values()]
}
