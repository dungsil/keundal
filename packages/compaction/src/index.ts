import type { AgentMessage, RunAgentInput } from '@keundal/core'

export interface CompactionRequest {
  readonly input: RunAgentInput
  readonly model: string
  readonly maxInputTokens: number
}

export interface CompactionResult {
  readonly messages: AgentMessage[]
  readonly summary: string
  readonly sourceMessageIds: string[]
}

export interface CompactionPolicy {
  readonly keepRecentMessages?: number
  readonly maxSummaryTokens?: number
  readonly keepRecentTokens?: number
  readonly threshold?: number
  readonly reserveTokens?: number
}

export interface AgentCompactionConfig extends CompactionPolicy {
  readonly models?: Readonly<Record<string, CompactionPolicy>>
}
