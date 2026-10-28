import type { RunBudget } from './index.js'

export function parseRunBudget(value: unknown): RunBudget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('budget must be an object')
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!['maxTokens', 'maxCost', 'maxDurationMs', 'unknownPricing'].includes(key))
      throw new Error(`budget.${key} is not supported`)
  }
  for (const key of ['maxTokens', 'maxDurationMs'] as const) {
    const count = source[key]
    if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0))
      throw new Error(`budget.${key} must be a positive integer`)
  }
  if (typeof source.maxDurationMs === 'number' && source.maxDurationMs > 2_147_483_647)
    throw new Error('budget.maxDurationMs must not exceed 2147483647')
  if (source.unknownPricing !== undefined && source.unknownPricing !== 'reject' && source.unknownPricing !== 'allow')
    throw new Error('budget.unknownPricing must be reject or allow')
  const cost = source.maxCost
  let maxCost: RunBudget['maxCost']
  if (cost !== undefined) {
    if (typeof cost !== 'object' || cost === null || Array.isArray(cost))
      throw new Error('budget.maxCost must be an object')
    const entry = cost as Record<string, unknown>
    if (
      Object.keys(entry).some((key) => key !== 'amount' && key !== 'currency') ||
      typeof entry.amount !== 'number' ||
      !Number.isFinite(entry.amount) ||
      entry.amount < 0 ||
      typeof entry.currency !== 'string' ||
      !entry.currency.trim()
    )
      throw new Error('budget.maxCost requires a non-negative amount and currency')
    maxCost = { amount: entry.amount, currency: entry.currency.trim() }
  }
  return {
    ...(typeof source.maxTokens === 'number' ? { maxTokens: source.maxTokens } : {}),
    ...(typeof source.maxDurationMs === 'number' ? { maxDurationMs: source.maxDurationMs } : {}),
    ...(maxCost ? { maxCost } : {}),
    unknownPricing: source.unknownPricing === 'allow' ? 'allow' : 'reject'
  }
}
