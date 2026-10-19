import type { LLMModel } from '@keundal/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'

export interface GeminiLLMConfig {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly models: Readonly<Record<string, LLMModel>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseConfig(value: unknown): GeminiLLMConfig {
  if (!isRecord(value) || !isRecord(value.models) || !Object.keys(value.models).length) {
    throw new Error('at least one model with contextWindow and maxOutputTokens is required')
  }
  for (const key of ['apiKey', 'baseURL']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim())) {
      throw new Error(`${key} must be a non-empty string`)
    }
  }
  if (
    value.headers !== undefined &&
    (!isRecord(value.headers) ||
      Object.entries(value.headers).some(
        ([name, header]) =>
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof header !== 'string' || !/^[\t\x20-\x7e]*$/.test(header)
      ))
  )
    throw new Error('headers must contain valid HTTP names and ASCII string values without line breaks')
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
  return {
    apiKey: value.apiKey as string | undefined,
    baseURL: value.baseURL as string | undefined,
    headers: value.headers as Record<string, string> | undefined,
    models
  }
}

export const GeminiLLMConfigSchema: StandardSchemaV1<GeminiLLMConfig, GeminiLLMConfig> = {
  '~standard': {
    version: 1,
    vendor: 'keundal',
    validate(value) {
      try {
        return { value: parseConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : 'invalid Gemini configuration' }] }
      }
    }
  }
}
