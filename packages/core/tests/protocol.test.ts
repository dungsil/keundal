import { EventType, parseAGUIEvent, parseRunAgentInput, type RunAgentInput } from '@keundal/core'
import { describe, expect, test } from 'vitest'

describe('run input contract', () => {
  test('preserves conversation, tool, and execution data from a wire request', () => {
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

  test('rejects a request with no run identifier', () => {
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

describe('event contract', () => {
  test('preserves tool-call fields and the event discriminator', () => {
    const event = { type: 'TOOL_CALL_ARGS', toolCallId: 'clock-1', delta: '{"timezone":"Asia/Seoul"}' }
    const parsed = parseAGUIEvent(event)
    expect(parsed).toStrictEqual(event)
    expect(parsed.type).toBe(EventType.TOOL_CALL_ARGS)
    if (parsed.type !== EventType.TOOL_CALL_ARGS) throw new Error('unexpected event type')
    expect(parsed.toolCallId).toBe('clock-1')
    expect(parsed.delta).toBe('{"timezone":"Asia/Seoul"}')
  })

  test('preserves successful execution identifiers and outcome', () => {
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
  ])('rejects malformed wire event $type', (event) => {
    expect(() => parseAGUIEvent(event)).toThrow()
  })
})
