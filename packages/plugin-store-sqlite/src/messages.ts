import { MessageAssembly, type AGUIEvent, type AgentMessage } from '@keundal/core'

import type { SqliteStore } from './store.js'

/** journal을 배치로 확정하는 기준 크기입니다. */
const JOURNAL_BATCH_SIZE = 32
/** journal을 배치로 확정하는 최대 간격입니다. */
const JOURNAL_BATCH_INTERVAL_MS = 50

/**
 * 실행 이벤트를 journal과 실행 메시지로 조립합니다. 코어의 조립기가 어시스턴트 텍스트·도구
 * 호출·추론 요약을 하나의 실행 결과로 모으고, 이 클래스는 배치마다 그 결과를 저장소에
 * 기록합니다. 실행이 중단되어도 마지막으로 확정한 지점까지 부분 응답이 남습니다.
 */
export class RunRecorder {
  private readonly assembly = new MessageAssembly()
  private pending: AGUIEvent[] = []
  private changed = new Map<string, AgentMessage>()
  private deadline?: number
  private stopped = false

  constructor(
    private readonly store: SqliteStore,
    private readonly runId: string,
    private readonly ownerId: string
  ) {}

  /**
   * 이벤트를 기록에 반영하고, 배치가 차면 journal에 확정합니다. 다른 소유자가 실행을 넘겨받은
   * 것이 확인되면 이후 기록을 멈추고 false를 돌려줍니다.
   */
  record(event: AGUIEvent): boolean {
    if (this.stopped) return false
    this.pending.push(event)
    const message = this.assembly.apply(event)
    if (message) this.changed.set(message.id, message)
    if (this.pending.length === 1) this.deadline = Date.now() + JOURNAL_BATCH_INTERVAL_MS
    const due = this.pending.length >= JOURNAL_BATCH_SIZE || Date.now() >= (this.deadline ?? Infinity)
    if (due) return this.flush()
    return true
  }

  /** 대기 중인 기록을 한 트랜잭션에 확정합니다. 종료 확정 전에 반드시 호출해야 합니다. */
  flush(): boolean {
    if (this.stopped || !this.pending.length) return !this.stopped
    const ok = this.store.transaction(() => {
      if (!this.store.ownsRun(this.runId, this.ownerId)) return false
      for (const event of this.pending) this.store.appendJournal(this.runId, event)
      if (this.changed.size) this.store.writeRunMessages(this.runId, [...this.changed.values()])
      return true
    })
    if (ok) {
      this.pending = []
      this.changed.clear()
      this.deadline = undefined
    } else {
      this.stopped = true
    }
    return ok
  }

  /** 조립이 완료된 실행 메시지입니다. */
  get messages(): readonly AgentMessage[] {
    return this.assembly.messages
  }
}
