import { MessageAssembly, type AGUIEvent, type AgentMessage } from '@keundal/core'
import { type GenerationJournalEntry } from '@keundal/generation'

/**
 * 실행 이벤트를 journal과 실행 메시지로 누적합니다. journal은 이벤트를 순서대로 보관하고, 실행
 * 메시지는 코어의 조립기가 어시스턴트 텍스트·도구 호출·추론 요약을 하나의 실행 결과로 모읍니다.
 * 조립이 거부한 이벤트는 저장 대상이 아니므로 journal에 남기지 않게 먼저 조립합니다.
 * 배열은 저장소가 참조하므로 실행 중에도 부분 응답이 그대로 저장됩니다.
 */
export class GenerationRecorder {
  readonly journal: GenerationJournalEntry[] = []

  private readonly assembly = new MessageAssembly()

  /** 조립한 실행 메시지입니다. 실행 중에는 부분 응답이 담깁니다. */
  get messages(): AgentMessage[] {
    return this.assembly.messages
  }

  /** 이벤트를 journal에 기록하고 추가한 항목을 돌려줍니다. */
  record(event: AGUIEvent): GenerationJournalEntry {
    this.assembly.apply(event)
    const entry = { sequence: this.journal.length, event }
    this.journal.push(entry)
    return entry
  }
}
