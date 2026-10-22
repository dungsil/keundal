import type { AgentMessage } from './protocol.js'

/**
 * 실행 중인 에이전트에 전달할 추가 사용자 지시를 순서대로 보관합니다. 에이전트는 진행 중인 모델
 * 요청이나 도구 실행을 중단하지 않고, 다음 요청을 만들기 전의 안전한 경계에서만 take()로
 * 비웁니다. 반영되지 않은 지시는 실행이 끝날 때까지 남으므로 호출자가 후속 실행으로 넘길 수
 * 있습니다.
 */
export class SteerQueue {
  private readonly messages: AgentMessage[] = []
  private closed = false

  /** 아직 반영하지 않은 지시의 수입니다. */
  get pending(): number {
    return this.messages.length
  }

  /** 종료된 대기열은 새로운 지시를 받지 않습니다. */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * 지시를 넣은 순서대로 추가합니다. 같은 메시지 id가 아직 대기 중이면 중복으로 보지 않고
   * 무시하며, 종료된 대기열에는 아무것도 넣지 않습니다. 받아들인 메시지 수를 돌려줍니다.
   */
  push(messages: readonly AgentMessage[]): number {
    if (this.closed) return 0
    let accepted = 0
    for (const message of messages) {
      if (this.messages.some((pending) => pending.id === message.id)) continue
      this.messages.push(message)
      accepted++
    }
    return accepted
  }

  /** 아직 반영하지 않은 지시를 넣은 순서대로 돌려주고 비웁니다. */
  take(): AgentMessage[] {
    return this.messages.splice(0, this.messages.length)
  }

  /** 더 이상 지시를 받지 않습니다. 남은 지시는 take()로 확인할 수 있습니다. */
  close(): void {
    this.closed = true
  }
}
