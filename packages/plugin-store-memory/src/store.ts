import type {
  AgentMessage,
  GenerationJournalEntry,
  GenerationRequest,
  GenerationStatus,
  RunAgentInput
} from '@keundal/core'

/** 스레드 하나의 저장 상태입니다. */
export interface StoredThread {
  /** 마지막으로 확정된 revision입니다. */
  revision: number
  /** 확정된 대화 메시지입니다. */
  messages: AgentMessage[]
  /** 마지막으로 확정된 상태입니다. */
  state: RunAgentInput['state']
}

/** 실행 하나의 저장 상태입니다. */
export interface StoredRun {
  readonly runId: string
  readonly threadId: string
  readonly request: GenerationRequest
  /** 실행 중에는 running이며, 종료를 확정하면 terminal 상태가 됩니다. */
  status: GenerationStatus
  journal: GenerationJournalEntry[]
  /** 실행이 생성한 메시지입니다. 실행 중에는 부분 응답이 담깁니다. */
  messages: AgentMessage[]
  owner?: symbol
  token?: symbol
  lease: { active: boolean }
}

/**
 * 대화와 실행을 프로세스 메모리에 보관합니다. 서비스 재등록 사이에 같은 인스턴스를 전달하면
 * 중단된 실행을 recover()로 복원할 수 있습니다. 프로세스가 종료되면 내용은 사라지며, 서로 다른
 * 프로세스 사이에서 공유되지 않습니다.
 */
export class MemoryStore {
  /** 확정된 스레드 상태입니다. */
  readonly threads = new Map<string, StoredThread>()
  /** 실행 기록입니다. 실행이 시작되면 running 상태로 추가됩니다. */
  readonly runs = new Map<string, StoredRun>()
}
