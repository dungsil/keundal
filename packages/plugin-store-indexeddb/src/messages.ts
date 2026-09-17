import { MessageAssembly, type AGUIEvent, type AgentMessage, type GenerationJournalEntry } from '@keundal/core'

/**
 * 실행 이벤트를 journal과 실행 메시지로 누적합니다. 코어의 조립기가 어시스턴트 텍스트·도구 호출·추론
 * 요약을 하나의 실행 결과로 모으므로, 저장된 journal만으로 실행 결과 메시지를 다시 조립할 때도 같은
 * 규칙을 사용합니다.
 */
export class GenerationRecorder {
  readonly journal: GenerationJournalEntry[] = []

  private readonly assembly = new MessageAssembly()

  get messages(): AgentMessage[] {
    return this.assembly.messages
  }

  record(event: AGUIEvent): void {
    this.journal.push({ sequence: this.journal.length, event })
    this.assembly.apply(event)
  }
}

export function recordJournal(entries: readonly GenerationJournalEntry[]): GenerationRecorder {
  const recorder = new GenerationRecorder()
  for (const entry of entries) recorder.record(entry.event)
  return recorder
}
