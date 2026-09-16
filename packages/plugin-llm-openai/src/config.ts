import type { LLMModel } from '@keundal/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'

export interface OpenAILLMConfig {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly models: Readonly<Record<string, LLMModel>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseConfig(value: unknown): OpenAILLMConfig {
  if (!isRecord(value) || !isRecord(value.models) || !Object.keys(value.models).length) {
    throw new Error('at least one model with contextWindow and maxOutputTokens is required')
  }
  for (const key of ['apiKey', 'baseURL']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim())) {
      throw new Error(`${key} must be a non-empty string`)
    }
  }
  const models: Record<string, LLMModel> = Object.create(null)
  for (const [name, limits] of Object.entries(value.models)) {
    if (
      !name.trim() ||
      !isRecord(limits) ||
      typeof limits.contextWindow !== 'number' ||
      !Number.isSafeInteger(limits.contextWindow) ||
      typeof limits.maxOutputTokens !== 'number' ||
      !Number.isSafeInteger(limits.maxOutputTokens) ||
      limits.maxOutputTokens <= 0 ||
      limits.contextWindow < limits.maxOutputTokens
    )
      throw new Error(`invalid model limits for ${name}`)
    models[name] = { contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens }
  }
  return { apiKey: value.apiKey as string | undefined, baseURL: value.baseURL as string | undefined, models }
}

export const OpenAILLMConfigSchema: StandardSchemaV1<OpenAILLMConfig, OpenAILLMConfig> = {
  '~standard': {
    version: 1,
    vendor: 'keundal',
    validate(value) {
      try {
        return { value: parseConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : 'invalid OpenAI configuration' }] }
      }
    }
  }
}
