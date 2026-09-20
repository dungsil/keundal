import { Service } from 'cordis'
import type { Context } from 'cordis'

import type { CompactionResult } from './compaction.js'
import type { ExecutionOptions } from './execution.js'
import type { LLMRequest, LLMService } from './llm.js'
import type { AGUIEvent, AgentMessage } from './protocol.js'

export interface GenerationRequest extends LLMRequest {
  readonly sessionRevision: number
  readonly compaction?: CompactionResult
}

export interface GenerationOptions extends ExecutionOptions {
  /** 실행에 사용할 이벤트 공급자입니다. 생략하면 주입된 llm.stream을 사용하며, 저장하거나 복구 시 재실행하지 않습니다. */
  readonly stream?: LLMService['stream']
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

  abstract run(request: GenerationRequest, options?: GenerationOptions): AsyncIterable<AGUIEvent>

  abstract get(runId: string, options?: ExecutionOptions): Promise<GenerationSnapshot | undefined>

  /** 저장된 모든 실행의 스냅숏을 저장소가 정한 안정적인 순서로 돌려줍니다. 상태는 바꾸지 않습니다. */
  abstract list(options?: ExecutionOptions): Promise<GenerationSnapshot[]>

  /**
   * 마지막 내구성 저장 지점까지 부분 응답과 상태를 복원하고 미완료 실행을 interrupted로
   * 확정합니다. LLM 재호출이나 자동 재시도는 수행하지 않습니다.
   */
  abstract recover(options?: ExecutionOptions): Promise<GenerationSnapshot[]>
}
