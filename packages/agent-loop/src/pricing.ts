import type { TraceCost, TraceUsage } from '@keundal/core'

import type { AgentPricing, ModelPrice } from './config.js'

const PRICE_FIELDS = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const

/** 설정 경계에서 일반 객체만 받습니다. 배열과 `null`은 라벨을 붙인 오류로 거부합니다. */
function plainObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function parsePrice(model: string, value: unknown): ModelPrice {
  const source = plainObject(value, `pricing.models.${model}`)
  for (const key of Object.keys(source)) {
    if (!(PRICE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`pricing.models.${model}.${key} is not a supported price field`)
    }
  }
  for (const field of PRICE_FIELDS) {
    const amount = source[field]
    if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) {
      throw new Error(`pricing.models.${model}.${field} must be a non-negative number`)
    }
  }
  const { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion } = source
  if (typeof inputPerMillion !== 'number' || typeof outputPerMillion !== 'number') {
    throw new Error(`pricing.models.${model} requires inputPerMillion and outputPerMillion`)
  }
  return {
    inputPerMillion,
    outputPerMillion,
    ...(typeof cacheReadPerMillion === 'number' ? { cacheReadPerMillion } : {}),
    ...(typeof cacheWritePerMillion === 'number' ? { cacheWritePerMillion } : {})
  }
}

/** 모델 가격표를 검증합니다. 알 수 없는 필드와 음수·비유한 금액은 오류로 알립니다. */
export function parsePricing(value: unknown): AgentPricing {
  const source = plainObject(value, 'pricing')
  for (const key of Object.keys(source)) {
    if (key !== 'currency' && key !== 'models') throw new Error(`pricing.${key} is not supported`)
  }
  if (typeof source.currency !== 'string' || !source.currency.trim()) {
    throw new Error('pricing.currency must be a non-empty string')
  }
  const modelsSource = plainObject(source.models, 'pricing.models')
  // 모델 ID가 `constructor` 같은 이름이어도 프로토타입 속성과 섞이지 않도록 합니다.
  const models: Record<string, ModelPrice> = Object.create(null)
  for (const [model, price] of Object.entries(modelsSource)) {
    if (!model.trim()) throw new Error('pricing.models keys must be non-empty model IDs')
    models[model] = parsePrice(model, price)
  }
  return { currency: source.currency.trim(), models }
}

/**
 * 가격표로 모델 호출의 비용을 추정합니다. 가격이 없거나 사용량이 부족하면 `undefined`입니다.
 *
 * `inputTokens`는 캐시 토큰을 포함하므로 캐시 토큰만큼 일반 입력에서 빼서 한 번씩만 계산합니다.
 * 캐시 가격이 없으면 해당 토큰에 입력 가격을 적용합니다.
 */
export function estimateCost(
  pricing: AgentPricing | undefined,
  model: string,
  usage: TraceUsage
): TraceCost | undefined {
  if (!pricing || !Object.hasOwn(pricing.models, model)) return undefined
  const price = pricing.models[model]!
  const { inputTokens, outputTokens } = usage
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const uncached = inputTokens - cacheRead - cacheWrite
  // 캐시 토큰이 총 입력보다 많으면 사용량 자체가 모순이므로 추정하지 않습니다.
  if (uncached < 0) return undefined
  const amount =
    (uncached * price.inputPerMillion +
      cacheRead * (price.cacheReadPerMillion ?? price.inputPerMillion) +
      cacheWrite * (price.cacheWritePerMillion ?? price.inputPerMillion) +
      outputTokens * price.outputPerMillion) /
    1_000_000
  return { currency: pricing.currency, amount, source: 'estimate' }
}
