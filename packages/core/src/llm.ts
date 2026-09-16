import { Service } from 'cordis'
import type { Context } from 'cordis'

import type { ExecutionOptions } from './execution.js'
import type { AGUIEvent, RunAgentInput } from './protocol.js'

export type LLMEvent = Exclude<AGUIEvent, { type: 'RUN_STARTED' | 'RUN_FINISHED' | 'RUN_ERROR' }>

export interface LLMModel {
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

export interface LLMRequest {
  readonly input: RunAgentInput
  readonly model: string
  readonly maxOutputTokens: number
}

export abstract class LLMService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  abstract getModel(model: string, options?: ExecutionOptions): Promise<LLMModel>

  abstract countTokens(request: LLMRequest, options?: ExecutionOptions): Promise<number>

  abstract stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterable<LLMEvent>
}
