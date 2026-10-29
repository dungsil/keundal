import type { ExecutionOptions } from '@keundal/core'
import type { AgentMessage, RunAgentInput } from '@keundal/core'
import type { TerminalGeneration } from '@keundal/generation'
import { Service } from 'cordis'
import type { Context } from 'cordis'

export interface SessionSnapshot {
  readonly threadId: string
  readonly revision: number
  readonly messages: AgentMessage[]
  readonly state: RunAgentInput['state']
  readonly metadata?: Record<string, unknown>
}

export interface PreparedSession {
  readonly input: RunAgentInput
  readonly revision: number
}

export interface SessionCommit {
  readonly threadId: string
  readonly expectedRevision: number
  /** 기본값은 merge이며 replace는 빈 배열을 포함해 전체 메시지를 교체합니다. */
  readonly mode?: 'merge' | 'replace'
  readonly messages: AgentMessage[]
  readonly state: RunAgentInput['state']
  readonly metadata?: Record<string, unknown>
  readonly generation?: TerminalGeneration
}

/**
 * prepare는 원본 세션을 저장하거나 변경하지 않고 요청과 저장된 대화로 모델 입력과 기준
 * revision을 준비합니다. 구체적인 병합 정책은 backend가 담당하며 input의 threadId와 runId를
 * 유지합니다.
 */
export abstract class SessionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'session')
  }

  abstract get(threadId: string, options?: ExecutionOptions): Promise<SessionSnapshot | undefined>

  /** 저장된 모든 스레드의 스냅숏을 저장소가 정한 안정적인 순서로 돌려줍니다. */
  abstract list(options?: ExecutionOptions): Promise<SessionSnapshot[]>

  /**
   * revision(없는 스레드는 0)을 검사하고 스레드와 모든 실행·journal을 원자적으로 삭제합니다.
   * running 실행이 있으면 거부하며 작업을 취소하지 않습니다. 호출자가 먼저 중단해야 합니다.
   * 영구 tombstone은 남기지 않으므로 준비된 입력과 새로운 동시 실행에는 기존 실행·revision
   * 계약이 적용됩니다.
   */
  abstract delete(threadId: string, expectedRevision: number, options?: ExecutionOptions): Promise<void>

  abstract prepare(input: RunAgentInput, options?: ExecutionOptions): Promise<PreparedSession>

  /**
   * expectedRevision을 검사합니다. generation이 있으면 메시지와 journal 및 종료 기록을 한
   * 커밋으로 확정하고, 중복 재적용을 방지해야 합니다.
   */
  abstract commit(change: SessionCommit, options?: ExecutionOptions): Promise<SessionSnapshot>
}

declare module 'cordis' {
  interface Context {
    readonly session: SessionService
  }
}
