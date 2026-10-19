import type { ExecutionOptions, LLMModelInfo } from '@keundal/core'
import { z } from 'zod'

import type { OpenAILLMConfig } from './config.js'

/** 생성 한도 설정 없이 엔드포인트의 모델 목록을 조회합니다. */
export async function listOpenAIModels(
  config: Pick<OpenAILLMConfig, 'baseURL' | 'headers'> & { readonly apiKey: string },
  options: ExecutionOptions = {}
): Promise<LLMModelInfo[]> {
  options.signal?.throwIfAborted()
  const configuredURL = config.baseURL ?? 'https://api.openai.com/v1'
  let end = configuredURL.length
  while (configuredURL[end - 1] === '/') end--
  const baseURL = configuredURL.slice(0, end)
  const response = await globalThis.fetch(`${baseURL}/models`, {
    headers: { authorization: `Bearer ${config.apiKey}`, ...config.headers },
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
      )
    })
    .parse(await response.json())
  options.signal?.throwIfAborted()
  return [
    ...new Map(
      page.data.map((model) => [
        model.id,
        {
          id: model.id,
          name: model.display_name || model.id,
          contextWindow: model.max_input_tokens ?? undefined,
          maxOutputTokens: model.max_tokens ?? undefined
        }
      ])
    ).values()
  ]
}
