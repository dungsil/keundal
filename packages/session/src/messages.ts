import type { AgentMessage } from '@keundal/core'

import type { SessionCommit } from './session.js'

/** 생성 결과는 이미 확정된 메시지를 덮어쓸 수 없습니다. 일반 편집과 종료 재시도는 호출자가 구분합니다. */
export function assertGenerationMessageIds(stored: readonly AgentMessage[], change: SessionCommit): void {
  if (!change.generation || !change.messages.length) return
  const ids = new Set(stored.map((message) => message.id))
  for (const message of change.messages) {
    if (ids.has(message.id)) throw new Error(`generation message conflicts with committed history: ${message.id}`)
  }
}
