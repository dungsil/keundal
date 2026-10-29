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

export interface AgentInputCapabilities {
  readonly systemMessages: boolean
}

/** Resolve optional app defaults separately from instructions explicitly requested by the caller. */
export function prepareChatInput(input: RunAgentInput, capabilities: AgentInputCapabilities): RunAgentInput {
  const { keundalChatInstructions, ...forwardedProps } = input.forwardedProps ?? {}
  if (keundalChatInstructions === undefined) return input
  if (
    !keundalChatInstructions ||
    typeof keundalChatInstructions !== 'object' ||
    typeof keundalChatInstructions.defaults !== 'string' ||
    (keundalChatInstructions.custom !== undefined && typeof keundalChatInstructions.custom !== 'string')
  ) {
    throw new Error('Invalid chat instructions')
  }
  const custom = keundalChatInstructions.custom?.trim()
  if (!capabilities.systemMessages && custom) throw new Error('This agent does not support custom system instructions')
  return {
    ...input,
    forwardedProps,
    messages: capabilities.systemMessages
      ? [
          {
            id: 'keundal:web-instructions',
            role: 'system',
            content: custom ? `${keundalChatInstructions.defaults}\n\n${custom}` : keundalChatInstructions.defaults
          },
          ...input.messages
        ]
      : input.messages
  }
}

declare module 'cordis' {
  interface Context {
    readonly agent: AgentService
  }
}
export abstract class AgentService extends Service {
  readonly inputCapabilities: AgentInputCapabilities = { systemMessages: true }

  constructor(ctx: Context) {
    super(ctx, 'agent')
  }
  abstract run(input: RunAgentInput, options?: AgentExecutionOptions): AsyncIterableIterator<AGUIEvent>
}
