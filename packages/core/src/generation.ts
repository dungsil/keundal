import { Service } from 'cordis'
import type { Context } from 'cordis'

import type { CompactionResult } from './compaction.js'
import type { ExecutionOptions } from './execution.js'
import type { LLMRequest } from './llm.js'
import type { AGUIEvent, AgentMessage } from './protocol.js'

export interface GenerationRequest extends LLMRequest {
  readonly sessionRevision: number
  readonly compaction?: CompactionResult
}

export type GenerationStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface GenerationJournalEntry {
  readonly sequence: number
  readonly event: AGUIEvent
}

export interface GenerationSnapshot {
  readonly request: GenerationRequest
  readonly status: GenerationStatus
  readonly journal: GenerationJournalEntry[]
  readonly messages: AgentMessage[]
}

export type TerminalGeneration = Omit<GenerationSnapshot, 'status'> & {
  readonly status: Exclude<GenerationStatus, 'running'>
}

/**
 * 성공 RUN_FINISHED는 내구성 커밋 후 전달합니다. 취소, iterator.return(), 플러그인 해제는
 * 구현이 협력적 취소와 정리를 수행해야 합니다.
 */
export abstract class GenerationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'generation')
  }

  abstract run(request: GenerationRequest, options?: ExecutionOptions): AsyncIterable<AGUIEvent>

  abstract get(runId: string, options?: ExecutionOptions): Promise<GenerationSnapshot | undefined>

  /**
   * 마지막 내구성 저장 지점까지 부분 응답과 상태를 복원하고 미완료 실행을 interrupted로
   * 확정합니다. LLM 재호출이나 자동 재시도는 수행하지 않습니다.
   */
  abstract recover(options?: ExecutionOptions): Promise<GenerationSnapshot[]>
}
