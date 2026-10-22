import type {} from '@keundal/agent'
import type {
  AGUIEvent,
  AgentMessage,
  ExecutionOptions,
  GenerationJournalEntry,
  GenerationService,
  GenerationSubscriptionOptions,
  Reasoning,
  RunAgentInput,
  SessionService,
  SkillSummary
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
  readonly toolCatalog?: (options: ExecutionOptions) => Promise<readonly SkillSummary[]>
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
  /** 실행 중인 실행에 지시를 넣고, 받아들인 메시지 수를 돌려줍니다. 실행이 없으면 0입니다. */
  steer(runId: string, messages: readonly AgentMessage[]): number
  /** 실행을 명시적으로 취소합니다. 취소할 실행이 없으면 false입니다. */
  cancel(runId: string): boolean
  /** 실행 journal을 재생하고 실행 중이면 실시간으로 이어받습니다. */
  subscribe(runId: string, options?: GenerationSubscriptionOptions): AsyncIterable<GenerationJournalEntry>
  session: Pick<SessionService, 'get' | 'list' | 'commit' | 'delete'>
  generation: Pick<GenerationService, 'get' | 'list' | 'recover'>
  models(): readonly AgentHostModel[]
  catalog?(options?: ExecutionOptions): Promise<{ skills: readonly SkillSummary[]; tools: readonly SkillSummary[] }>
  title(request: AgentHostTitleRequest, options?: ExecutionOptions): Promise<string>
}

export interface AgentHost {
  readonly ctx: Context
  readonly model: string
  readonly services: AgentHostServices
  dispose(): Promise<void>
}
