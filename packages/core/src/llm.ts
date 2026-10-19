import { Service } from 'cordis'
import type { Context } from 'cordis'

import type { ExecutionOptions } from './execution.js'
import type { AGUIEvent, RunAgentInput } from './protocol.js'

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

export interface LLMRequest {
  readonly input: RunAgentInput
  readonly model: string
  readonly maxOutputTokens: number
  readonly webSearch?: boolean
  readonly reasoning?: boolean
}

export abstract class LLMService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  abstract getModel(model: string, options?: ExecutionOptions): Promise<LLMModel>

  abstract countTokens(request: LLMRequest, options?: ExecutionOptions): Promise<number>

  abstract stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterable<LLMEvent>
}
