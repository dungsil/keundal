import { mergeMessages, type RunAgentInput } from '@keundal/core'

/** 에이전트 설정의 시스템 지침을 담는 예약 메시지 ID입니다. */
export const SYSTEM_PROMPT_ID = 'keundal:system-prompt'

/**
 * 시스템 지침을 예약 ID의 system 메시지로 앞세웁니다. 세션이 이전 지침을 반환하면 같은 ID의
 * 현재 지침으로 대체하므로 지침이 쌓이지 않습니다.
 */
export function withSystemPrompt(input: RunAgentInput, prompt?: string): RunAgentInput {
  if (!prompt) return input
  const message = { id: SYSTEM_PROMPT_ID, role: 'system' as const, content: prompt }
  return {
    ...input,
    messages: input.messages.some((existing) => existing.id === SYSTEM_PROMPT_ID)
      ? mergeMessages(input.messages, [message])
      : [message, ...input.messages]
  }
}
