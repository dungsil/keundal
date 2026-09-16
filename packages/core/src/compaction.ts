import { Service } from 'cordis'
import type { Context } from 'cordis'

import type { ExecutionOptions } from './execution.js'
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

/** 원본 세션을 변경하지 않고 모델 입력 메시지와 요약 범위를 반환합니다. */
export abstract class CompactionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'compaction')
  }

  abstract compact(request: CompactionRequest, options?: ExecutionOptions): Promise<CompactionResult>
}
