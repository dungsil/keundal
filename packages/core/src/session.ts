import { Service } from 'cordis'
import type { Context } from 'cordis'

import type { ExecutionOptions } from './execution.js'
import type { TerminalGeneration } from './generation.js'
import type { AgentMessage, RunAgentInput } from './protocol.js'

export interface SessionSnapshot {
  readonly threadId: string
  readonly revision: number
  readonly messages: AgentMessage[]
  readonly state: RunAgentInput['state']
}

export interface PreparedSession {
  readonly input: RunAgentInput
  readonly revision: number
}

export interface SessionCommit {
  readonly threadId: string
  readonly expectedRevision: number
  readonly messages: AgentMessage[]
  readonly state: RunAgentInput['state']
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

  abstract prepare(input: RunAgentInput, options?: ExecutionOptions): Promise<PreparedSession>

  /**
   * expectedRevision을 검사합니다. generation이 있으면 메시지와 journal 및 종료 기록을 한
   * 커밋으로 확정하고, 중복 재적용을 방지해야 합니다.
   */
  abstract commit(change: SessionCommit, options?: ExecutionOptions): Promise<SessionSnapshot>
}
