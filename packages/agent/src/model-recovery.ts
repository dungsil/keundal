/** Bounded recovery for one model request, not the entire run. */
export interface ModelRetryConfig {
  readonly maxRetries?: number
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
}

export interface ModelRecoveryPolicy {
  readonly retry?: ModelRetryConfig | false
  readonly fallbackModels?: readonly string[]
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

export function parseModelRecoveryPolicy(value: unknown): ModelRecoveryPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('model recovery policy must be an object')
  const source = value as Record<string, unknown>
  if (Object.keys(source).some((key) => !['retry', 'fallbackModels'].includes(key)))
    throw new Error('unknown model recovery option')
  return { retry: parseModelRetry(source.retry), fallbackModels: parseFallbackModels(source.fallbackModels) ?? [] }
}
