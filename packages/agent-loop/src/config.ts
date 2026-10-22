import type { Reasoning } from '@keundal/core'
import type { DeferredToolsConfig, ExecutableTool, ToolProvider } from '@keundal/tools'

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

export interface AgentConfig {
  readonly model: string
  readonly maxOutputTokens: number
  readonly webSearch?: boolean
  readonly reasoning?: Reasoning
  readonly compaction?: AgentCompactionConfig
  readonly tools?: readonly ExecutableTool[] | ToolProvider
  /** 도구를 검색한 뒤 다음 모델 요청에서만 노출합니다. */
  readonly deferredTools?: DeferredToolsConfig
  /** 지연 도구만 공급합니다. 기존 tools 공급자와 별도로 조회합니다. */
  readonly deferredToolProvider?: ToolProvider
  readonly subagents?: boolean
  readonly maxActiveSubagents?: number
  readonly skills?: boolean
  readonly context?: boolean
  /** 모든 실행에 앞서 모델에 전달할 시스템 지침입니다. */
  readonly systemPrompt?: string
  /** 도구 실행 뒤 후속 생성을 요청할 최대 횟수입니다. 기본값은 8입니다. */
  readonly maxToolRounds?: number
  /** 한 실행에서 허용할 도구 호출의 최대 개수입니다. 기본값은 32입니다. */
  readonly maxToolCalls?: number
  /** 같은 응답의 도구를 병렬로 실행합니다. 기본값은 false입니다. */
  readonly parallelTools?: boolean
}
