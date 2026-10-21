import { z } from 'zod'

import { providerType } from './llm-settings'
export const modelSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  icon: z.string(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional()
})
export type ModelOption = z.infer<typeof modelSchema>

/** Preserve model aliases already saved in conversations, but accept discovered IDs verbatim. */
export function resolveModel(value: string) {
  const separator = value.indexOf('/')
  const configuration = value.slice(0, separator)
  const provider = providerType(configuration)
  let id = value.slice(separator + 1)
  if (!provider || separator < 0 || !id.trim()) throw new Error('Unknown chat model')
  if (value === 'anthropic/claude-haiku-4.5') id = 'claude-haiku-4-5'
  if (value === 'google/gemini-3-flash') id = 'gemini-3-flash-preview'
  return { provider, configuration, id, value: `${configuration}/${id}` }
}
