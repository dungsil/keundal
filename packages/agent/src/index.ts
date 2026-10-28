import type { AGUIEvent, ExecutionOptions, RunAgentInput } from '@keundal/core'
import { Service, type Context } from 'cordis'

export * from './model-recovery.js'
export { parseRunBudget } from './budget.js'

export interface RunBudget {
  /** Total input + output tokens across all model requests, including children and compaction. */
  readonly maxTokens?: number
  readonly maxCost?: { readonly amount: number; readonly currency: string }
  /** Wall-clock deadline, including preparation and tools. At most 2147483647 ms. */
  readonly maxDurationMs?: number
  /** Missing prices or incompatible currencies reject by default when maxCost is set. */
  readonly unknownPricing?: 'reject' | 'allow'
}

export interface AgentExecutionOptions extends ExecutionOptions {
  /** Replaces the configured default for this run. */
  readonly budget?: RunBudget
}

declare module 'cordis' {
  interface Context {
    readonly agent: AgentService
  }
}
export abstract class AgentService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agent')
  }
  abstract run(input: RunAgentInput, options?: AgentExecutionOptions): AsyncIterableIterator<AGUIEvent>
}
