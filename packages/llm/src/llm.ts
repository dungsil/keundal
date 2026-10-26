import type { ExecutionOptions } from '@keundal/core'
import type { AGUIEvent, RunAgentInput } from '@keundal/core'
import { Service } from 'cordis'
import type { Context } from 'cordis'

export type LLMEvent = Exclude<AGUIEvent, { type: 'RUN_STARTED' | 'RUN_FINISHED' | 'RUN_ERROR' }>

export const LLM_SOURCE_EVENT = 'keundal.source'

export interface LLMSource {
  readonly id: string
  readonly url: string
  readonly title?: string
}

export interface LLMModel {
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

/** 모델 목록의 메타데이터입니다. 생성 지원 여부와 설정된 한도를 보장하지 않습니다. */
export interface LLMModelInfo {
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

export type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Reasoning = boolean | ReasoningLevel

export function parseReasoning(value: unknown): Reasoning | undefined {
  if (
    value === undefined ||
    typeof value === 'boolean' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
    return value
  throw new Error('reasoning must be a boolean or low, medium, high, xhigh, max')
}

export interface LLMRequest {
  readonly input: RunAgentInput
  readonly model: string
  readonly maxOutputTokens: number
  readonly webSearch?: boolean
  readonly reasoning?: Reasoning
}

export abstract class LLMService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  abstract getModel(model: string, options?: ExecutionOptions): Promise<LLMModel>

  abstract countTokens(request: LLMRequest, options?: ExecutionOptions): Promise<number>

  abstract stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterable<LLMEvent>
}

declare module 'cordis' {
  interface Context {
    readonly llm: LLMService
  }
}
