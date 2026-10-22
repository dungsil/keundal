import { MessageAssembly, type AGUIEvent, type AgentMessage, type GenerationJournalEntry } from '@keundal/core'

import type { SqliteStore } from './store.js'

/** journal을 배치로 확정하는 기준 크기입니다. */
const JOURNAL_BATCH_SIZE = 32
/** journal을 배치로 확정하는 최대 간격입니다. */
const JOURNAL_BATCH_INTERVAL_MS = 50

/**
 * 실행 이벤트를 journal과 실행 메시지로 조립합니다. 코어의 조립기가 어시스턴트 텍스트·도구
 * 호출·추론 요약을 하나의 실행 결과로 모으고, 이 클래스는 배치마다 이벤트만 저장소에
 * 기록합니다. 확정이 끝날 때까지 버퍼를 유지하므로, 저장소를 읽는 실시간 구독도 대기 중인
 * 기록을 이어서 볼 수 있습니다.
 */
export class RunRecorder {
  private readonly assembly = new MessageAssembly()
  private pending: GenerationJournalEntry[] = []
  private written: number
  private deadline?: number
  private stopped = false

  constructor(
    private readonly store: SqliteStore,
    private readonly runId: string,
    private readonly ownerId: string,
    private readonly publish: (entry: GenerationJournalEntry) => void
  ) {
    this.written = store.journalLength(runId)
  }

  /** 아직 저장소에 확정하지 않은 journal 항목입니다. 확정된 뒤에 접두부부터 제거됩니다. */
  get buffered(): readonly GenerationJournalEntry[] {
    return this.pending
  }

  /**
   * 이벤트를 기록에 반영하고, 배치가 차면 journal에 확정합니다. 다른 소유자가 실행을 넘겨받은
   * 것이 확인되면 이후 기록을 멈추고 false를 돌려줍니다.
   */
  record(event: AGUIEvent): boolean {
    if (this.stopped) return false
    // 조립이 거부한 이벤트는 journal 대상이 아니므로, 오류 경로의 flush가 남기지 않게 먼저 조립합니다.
    this.assembly.apply(event)
    const entry = { sequence: this.written + this.pending.length, event }
    this.pending.push(entry)
    this.publish(entry)
    if (this.pending.length === 1) this.deadline = Date.now() + JOURNAL_BATCH_INTERVAL_MS
    const due = this.pending.length >= JOURNAL_BATCH_SIZE || Date.now() >= (this.deadline ?? Infinity)
    if (due) return this.flush()
    return true
  }

  /** 대기 중인 기록을 한 트랜잭션에 확정합니다. 종료 확정 전에 반드시 호출해야 합니다. */
  flush(): boolean {
    if (this.stopped || !this.pending.length) return !this.stopped
    // 확정할 접두부는 성공한 뒤에 제거합니다. 진행 중인 쓰기 동안에도 journal이 끊기지 않아야 합니다.
    const entries = this.pending
    const ok = this.store.transaction(() => {
      if (!this.store.ownsRun(this.runId, this.ownerId)) return false
      this.store.writeJournal(this.runId, entries)
      return true
    })
    if (ok) {
      this.written += entries.length
      this.pending = this.pending.slice(entries.length)
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
