import type { Reasoning, AGUIEvent, AgentTool, ExecutionOptions, RunAgentInput } from '@keundal/core'
import { Service, type Context } from 'cordis'

export interface ToolExecutionContext {
  readonly threadId: string
  readonly runId: string
  readonly toolCallId: string
  readonly signal: AbortSignal
}

export interface ExecutableTool extends AgentTool {
  /** JSON 객체로 해석한 인자를 검증하고 실행합니다. 반환한 문자열은 도구 결과 메시지가 됩니다. */
  readonly execute: (args: Record<string, unknown>, context: ToolExecutionContext) => string | Promise<string>
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

export type ToolProvider = (options: ExecutionOptions) => readonly ExecutableTool[] | Promise<readonly ExecutableTool[]>

export interface AgentConfig {
  readonly model: string
  readonly maxOutputTokens: number
  readonly webSearch?: boolean
  readonly reasoning?: Reasoning
  readonly compaction?: AgentCompactionConfig
  readonly tools?: readonly ExecutableTool[] | ToolProvider
  readonly skills?: boolean
  readonly context?: boolean
  /** 모든 실행에 앞서 모델에 전달할 시스템 지침입니다. */
  readonly systemPrompt?: string
  /** 도구를 실행하고 후속 생성을 요청할 최대 횟수입니다. 기본값은 8입니다. */
  readonly maxToolRounds?: number
  /** 같은 응답의 도구 실행을 겹쳐 시작합니다. 기본값은 false로 순차 실행입니다. */
  /** 한 실행에서 허용할 도구 호출의 최대 개수입니다. 기본값은 32입니다. */
  readonly maxToolCalls?: number
  readonly parallelTools?: boolean
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
  abstract run(input: RunAgentInput, options?: ExecutionOptions): AsyncIterableIterator<AGUIEvent>
}
