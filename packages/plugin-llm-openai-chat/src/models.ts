import type { ExecutionOptions } from '@keundal/core'
import type { LLMModelInfo } from '@keundal/llm'
import { MODEL_CATALOG_LIMITS, ModelCatalogBudget, readModelCatalogCapabilities } from '@keundal/llm'
import { z } from 'zod'

import type { OpenAIChatLLMConfig } from './config.js'

/** 생성 한도 설정 없이 엔드포인트의 모델 목록을 조회합니다. */
export async function listOpenAIChatModels(
  config: Pick<OpenAIChatLLMConfig, 'baseURL' | 'headers'> & { readonly apiKey: string },
  options: ExecutionOptions = {}
): Promise<LLMModelInfo[]> {
  options.signal?.throwIfAborted()
  const budget = new ModelCatalogBudget()
  const configuredURL = config.baseURL ?? 'https://api.openai.com/v1'
  let end = configuredURL.length
  while (configuredURL[end - 1] === '/') end--
  const baseURL = configuredURL.slice(0, end)
  budget.beginPage()
  const response = await globalThis.fetch(`${baseURL}/models`, {
    headers: { ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}), ...config.headers },
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
      data: z.array(
        z.object({
          id: z.string().min(1).max(MODEL_CATALOG_LIMITS.fieldLength),
          display_name: z.string().max(MODEL_CATALOG_LIMITS.fieldLength).optional(),
          max_input_tokens: z.number().positive().nullish(),
          max_tokens: z.number().positive().nullish(),
          capabilities: z.unknown().transform(readModelCatalogCapabilities).optional()
        })
      )
    })
    .parse(await budget.readJSON(response))
  budget.acceptEntries(page.data.length)
  options.signal?.throwIfAborted()
  return [
    ...new Map(
      page.data.map((model) => [
        model.id,
        {
          id: model.id,
          name: model.display_name || model.id,
          contextWindow: model.max_input_tokens ?? undefined,
          maxOutputTokens: model.max_tokens ?? undefined,
          capabilities: model.capabilities
        }
      ])
    ).values()
  ]
}
