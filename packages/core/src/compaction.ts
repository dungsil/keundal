import type { AgentMessage, RunAgentInput } from './protocol.js'

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
