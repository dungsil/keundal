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

/** 100만 토큰당 가격입니다. 캐시 가격을 생략하면 해당 토큰에 입력 가격을 적용합니다. */
export interface ModelPrice {
  readonly inputPerMillion: number
  readonly outputPerMillion: number
  readonly cacheReadPerMillion?: number
  readonly cacheWritePerMillion?: number
}

/** 모델 ID별 가격표입니다. 한 표는 하나의 통화만 사용합니다. */
export interface AgentPricing {
  readonly currency: string
  readonly models: Readonly<Record<string, ModelPrice>>
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
  /**
   * 공급자가 비용을 주지 않는 모델 호출의 비용을 `source: 'estimate'`로 추정합니다.
   * 가격표에 없는 모델은 비용을 미확정으로 둡니다.
   */
  readonly pricing?: AgentPricing
}
