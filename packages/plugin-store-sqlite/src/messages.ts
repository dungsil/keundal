import { MessageAssembly, type AGUIEvent } from '@keundal/core'

import type { SqliteStore } from './store.js'

/**
 * 실행 이벤트를 journal과 실행 메시지로 조립합니다. 코어의 조립기가 어시스턴트 텍스트·도구
 * 호출·추론 요약을 하나의 실행 결과로 모으고, 이 클래스는 이벤트마다 그 결과를 저장소에
 * 기록합니다. 실행이 중단되어도 마지막으로 기록한 지점까지 부분 응답이 남습니다.
 */
export class RunRecorder {
  private readonly assembly = new MessageAssembly()

  constructor(
    private readonly store: SqliteStore,
    private readonly runId: string,
    private readonly ownerId: string
  ) {}

  /**
   * 이벤트를 journal에 추가하고, 바뀐 실행 메시지를 저장합니다. 다른 소유자가 실행을 넘겨받았거나
   * 실행이 종료를 확정했으면 기록을 멈추고 false를 돌려줍니다.
   */
  record(event: AGUIEvent): boolean {
    return this.store.transaction(() => {
      if (!this.store.ownsRun(this.runId, this.ownerId)) return false
      this.store.appendJournal(this.runId, event)
      const message = this.assembly.apply(event)
      if (message) this.store.writeRunMessages(this.runId, [message])
      return true
    })
  }
}
