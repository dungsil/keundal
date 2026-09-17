import { parseAGUIEvent, parseRunAgentInput, type RunAgentInput } from '@keundal/core'
import { describe, expect, test } from 'vitest'

describe('실행 입력 계약', () => {
  test('수신한 요청의 대화, 도구, 실행 데이터를 보존한다', () => {
    const input: RunAgentInput = {
      threadId: 'conversation-1',
      runId: 'generation-2',
      parentRunId: 'generation-1',
      state: { revision: 3 },
      messages: [{ id: 'question', role: 'user', content: 'What time is it?' }],
      tools: [{ name: 'clock', description: 'Read the clock', parameters: { type: 'object' } }],
      context: [{ description: 'timezone', value: 'Asia/Seoul' }],
      forwardedProps: { model: 'test-model' }
    }

    expect(parseRunAgentInput(input)).toStrictEqual(input)
  })

  test('실행 식별자가 없는 요청을 거부한다', () => {
    expect(() =>
      parseRunAgentInput({
        threadId: 'conversation-1',
        state: {},
        messages: [],
        tools: [],
        context: []
      })
    ).toThrow()
  })
})

describe('이벤트 계약', () => {
  test('도구 호출 필드와 이벤트 유형을 보존한다', () => {
    const event = { type: 'TOOL_CALL_ARGS', toolCallId: 'clock-1', delta: '{"timezone":"Asia/Seoul"}' }
    const parsed = parseAGUIEvent(event)
    expect(parsed).toStrictEqual(event)
  })

  test('성공한 실행의 식별자와 결과를 보존한다', () => {
    const event = {
      type: 'RUN_FINISHED',
      threadId: 'conversation-1',
      runId: 'generation-2',
      outcome: { type: 'success' }
    }
    expect(parseAGUIEvent(event)).toStrictEqual(event)
  })

  test.each([
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply' },
    { type: 'TOOL_CALL_ARGS', delta: '{}' },
    { type: 'RUN_STARTED', threadId: 'conversation-1' },
    { type: 'UNKNOWN_EVENT' }
  ])('형식이 잘못된 $type 이벤트를 거부한다', (event) => {
    expect(() => parseAGUIEvent(event)).toThrow()
  })
})
