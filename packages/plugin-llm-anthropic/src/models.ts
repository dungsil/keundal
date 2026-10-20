import type { ExecutionOptions, LLMModelInfo } from '@keundal/core'
import { z } from 'zod'

import type { AnthropicLLMConfig } from './config.js'

/** 생성 한도 설정 없이 엔드포인트의 모델 목록을 모든 페이지에서 조회합니다. */
export async function listAnthropicModels(
  config: Omit<AnthropicLLMConfig, 'models' | 'apiKey'> & { readonly apiKey: string },
  options: ExecutionOptions = {}
): Promise<LLMModelInfo[]> {
  const configuredURL = config.baseURL ?? 'https://api.anthropic.com'
  let end = configuredURL.length
  while (configuredURL[end - 1] === '/') end--
  const baseURL = configuredURL.slice(0, end)
  const models = new Map<string, LLMModelInfo>()
  const cursors = new Set<string>()
  let cursor = ''
  do {
    options.signal?.throwIfAborted()
    const url = new globalThis.URL(`${baseURL}/v1/models`)
    url.searchParams.set('limit', '1000')
    if (cursor) url.searchParams.set('after_id', cursor)
    const response = await globalThis.fetch(url, {
      headers: {
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
        'anthropic-version': '2023-06-01',
        ...(config.dangerouslyAllowBrowser ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
        ...config.headers
      },
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
        data: z.array(
          z.object({
            id: z.string().min(1),
            display_name: z.string().optional(),
            max_input_tokens: z.number().positive().nullish(),
            max_tokens: z.number().positive().nullish()
          })
        ),
        has_more: z.boolean().optional(),
        last_id: z.string().nullish()
      })
      .parse(await response.json())
    for (const model of page.data)
      models.set(model.id, {
        id: model.id,
        name: model.display_name || model.id,
        contextWindow: model.max_input_tokens ?? undefined,
        maxOutputTokens: model.max_tokens ?? undefined
      })
    cursor = page.has_more ? page.last_id || '' : ''
    if (page.has_more && !cursor) throw new Error('Invalid models cursor')
    if (cursor && cursors.has(cursor)) throw new Error('Repeated models cursor')
    cursors.add(cursor)
  } while (cursor)
  options.signal?.throwIfAborted()
  return [...models.values()]
}
