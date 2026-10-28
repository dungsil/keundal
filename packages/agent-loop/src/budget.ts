import type { RunBudget } from '@keundal/agent'
import { EventType, type ExecutionOptions } from '@keundal/core'
import type { LLMService, LLMEvent, LLMRequest } from '@keundal/llm'
import { LLM_USAGE_EVENT, estimateCost, type AgentPricing, type TraceUsage } from '@keundal/trace'
import { usageFromEvent } from '@keundal/trace/recording'

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

/** One ledger belongs to a root run, including concurrent children and compaction. */
export class BudgetLedger {
  private tokens = 0
  private cost = 0
  private reservedTokens = 0
  private reservedCost = 0
  private readonly startedAt = globalThis.performance.now()

  constructor(
    private readonly policy: RunBudget,
    private readonly pricing: AgentPricing | undefined,
    private readonly abort: (reason: Error) => void
  ) {}

  private fail(reason: string): never {
    const error = new Error(`run budget exceeded: ${reason}`)
    this.abort(error)
    throw error
  }

  private check(tokens = 0, cost = 0): void {
    if (
      this.policy.maxDurationMs !== undefined &&
      globalThis.performance.now() - this.startedAt >= this.policy.maxDurationMs
    )
      this.fail('duration')
    if (this.policy.maxTokens !== undefined && this.tokens + this.reservedTokens + tokens > this.policy.maxTokens)
      this.fail('tokens')
    if (this.policy.maxCost && this.cost + this.reservedCost + cost > this.policy.maxCost.amount) this.fail('cost')
  }

  wrap(llm: LLMService): Pick<LLMService, 'getModel' | 'countTokens' | 'stream'> {
    return {
      getModel: (model, options) => llm.getModel(model, options),
      countTokens: (request, options) => llm.countTokens(request, options),
      stream: (request, options) => this.stream(llm, request, options)
    }
  }

  private async *stream(llm: LLMService, request: LLMRequest, options?: ExecutionOptions): AsyncGenerator<LLMEvent> {
    options?.signal?.throwIfAborted()
    this.check()
    const input = await llm.countTokens(request, options)
    options?.signal?.throwIfAborted()
    if (!Number.isSafeInteger(input) || input < 0) throw new Error('invalid input token count')
    const estimate: TraceUsage = { source: 'estimate', inputTokens: input, outputTokens: request.maxOutputTokens }
    const quoted = estimateCost(this.pricing, request.model, estimate)
    const compatible = quoted !== undefined && quoted.currency === this.policy.maxCost?.currency
    if (this.policy.maxCost && (!quoted || !compatible) && this.policy.unknownPricing !== 'allow')
      this.fail('unknown model pricing or currency')
    let reservation = input + request.maxOutputTokens
    let costReservation = compatible ? quoted!.amount : 0
    // No await between checking and reserving: parallel children cannot spend the same remainder.
    this.check(reservation, costReservation)
    this.reservedTokens += reservation
    this.reservedCost += costReservation
    let usage: ReturnType<typeof usageFromEvent>
    let providerCost: NonNullable<typeof usage>['cost']
    let chargedTokens = reservation
    let chargedCost = costReservation
    try {
      for await (const event of llm.stream(request, options)) {
        options?.signal?.throwIfAborted()
        if (event.type === EventType.CUSTOM && event.name === LLM_USAGE_EVENT) {
          const parsed = usageFromEvent(event.value)
          if (parsed) {
            usage = parsed
            providerCost = parsed.cost ?? providerCost
            chargedTokens = (parsed.usage.inputTokens ?? input) + (parsed.usage.outputTokens ?? request.maxOutputTokens)
            const tokens = Math.max(reservation, chargedTokens)
            const cost =
              providerCost ??
              estimateCost(this.pricing, request.model, {
                ...parsed.usage,
                inputTokens: parsed.usage.inputTokens ?? input,
                outputTokens: parsed.usage.outputTokens ?? request.maxOutputTokens
              })
            this.reservedTokens += tokens - reservation
            reservation = tokens
            if (cost && cost.currency === this.policy.maxCost?.currency) {
              chargedCost = cost.amount
              const held = Math.max(costReservation, chargedCost)
              this.reservedCost += held - costReservation
              costReservation = held
            } else if (this.policy.maxCost && cost && this.policy.unknownPricing !== 'allow') {
              this.fail('unknown cost currency')
            }
          }
        }
        yield event
        this.check()
      }
    } finally {
      this.reservedTokens -= reservation
      this.reservedCost -= costReservation
      // Missing fields retain their reservation, rather than being silently treated as zero.
      this.tokens += chargedTokens
      this.cost += chargedCost
      this.check()
    }
    if (!usage) yield { type: EventType.CUSTOM, name: LLM_USAGE_EVENT, value: estimate }
  }
}
