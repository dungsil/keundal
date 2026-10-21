import type {} from '@keundal/agent'
import type {
  AGUIEvent,
  AgentMessage,
  ExecutionOptions,
  GenerationService,
  Reasoning,
  RunAgentInput,
  SessionService
} from '@keundal/core'
import type { Context, Fiber } from 'cordis'

export interface AgentHostModel {
  readonly id: string
  readonly provider: AgentHostProvider
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

export type AgentHostProvider = string

export interface AgentMountConfig {
  readonly model: string
  readonly maxOutputTokens: number
  readonly reasoning?: Reasoning
}

export interface AgentHostOptions {
  readonly model: string
  readonly models: readonly AgentHostModel[]
  readonly maxOutputTokens?: number
  /** The application installs services within this owned plugin scope. */
  readonly setup: (ctx: Context) => Promise<void>
  readonly mountAgent: (ctx: Context, config: AgentMountConfig) => Promise<Fiber>
}

export interface AgentHostRunOptions extends ExecutionOptions {
  readonly reasoning?: Reasoning
  readonly model?: string
}

export interface AgentHostTitleRequest {
  readonly model: string
  readonly message: AgentMessage
}

/** HTTP 계층과 sidecar가 공통으로 사용하는 에이전트 표면입니다. */
export interface AgentHostServices {
  run(input: RunAgentInput, options?: AgentHostRunOptions): AsyncIterable<AGUIEvent>
  session: Pick<SessionService, 'get' | 'list' | 'commit' | 'delete'>
  generation: Pick<GenerationService, 'get' | 'list' | 'recover'>
  models(): readonly AgentHostModel[]
  title(request: AgentHostTitleRequest, options?: ExecutionOptions): Promise<string>
}

export interface AgentHost {
  readonly ctx: Context
  readonly model: string
  readonly services: AgentHostServices
  dispose(): Promise<void>
}
