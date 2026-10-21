import {
  CONTEXT_MESSAGE_EVENT,
  EventType,
  MessageAssembly,
  mergeMessages,
  prepareReplayMessages,
  type AgentMessage
} from '@keundal/core'
import { expect, test } from 'vitest'

test.each(['provider/model-a', 'provider/model-b', 'other/model-a'])(
  '%s에 재전송할 때 완료된 호출을 보존하고 같은 모델의 서명과 메타데이터만 유지한다',
  (targetModel) => {
    const signed: AgentMessage = { id: 'signed', role: 'reasoning', content: 'Reasoning', encryptedValue: 'signature' }
    const call = {
      id: 'complete',
      type: 'function' as const,
      function: { name: 'lookup', arguments: '{}' },
      encryptedValue: 'tool-signature'
    }
    const reply: AgentMessage = {
      id: 'reply',
      role: 'assistant',
      content: 'Answer',
      metadata: { native: 'opaque' },
      toolCalls: [call, { ...call, id: 'pending', function: { name: 'lookup', arguments: '{' } }]
    }
    const result: AgentMessage = { id: 'result', role: 'tool', toolCallId: 'complete', content: 'Found' }
    const messages: AgentMessage[] = [
      { id: 'user', role: 'user', content: 'Question' },
      { id: 'unsigned', role: 'reasoning', content: 'Partial reasoning' },
      signed,
      reply,
      result
    ]
    const original = structuredClone(messages)
    const sameModel = targetModel === 'provider/model-a'
    expect(prepareReplayMessages(messages, 'provider/model-a', targetModel)).toStrictEqual([
      messages[0],
      ...(sameModel ? [signed] : []),
      {
        ...reply,
        metadata: sameModel ? { native: 'opaque' } : undefined,
        toolCalls: [
          sameModel ? call : { id: 'complete', type: 'function', function: { name: 'lookup', arguments: '{}' } }
        ]
      },
      result
    ])
    expect(messages).toStrictEqual(original)
  }
)

test('같은 ID를 재전송하면 기존 위치에서 마지막 값으로 교체하고 입력을 변경하지 않는다', () => {
  const stored: AgentMessage[] = [
    { id: 'A', role: 'user', content: 'Original A' },
    { id: 'B', role: 'assistant', content: 'Original B' }
  ]
  const incoming: AgentMessage[] = [
    { id: 'A', role: 'user', content: 'Updated A' },
    { id: 'C', role: 'user', content: 'New C' },
    { id: 'A', role: 'user', content: 'Final A', metadata: { revision: 2 } },
    { id: 'C', role: 'user', content: 'Final C' }
  ]
  const originals = globalThis.structuredClone({ stored, incoming })

  expect(mergeMessages(stored, incoming)).toStrictEqual([
    { id: 'A', role: 'user', content: 'Final A', metadata: { revision: 2 } },
    { id: 'B', role: 'assistant', content: 'Original B' },
    { id: 'C', role: 'user', content: 'Final C' }
  ])
  expect({ stored, incoming }).toStrictEqual(originals)
})

test('텍스트 시작 메타데이터를 내용과 종료 이벤트 이후에도 보존한다', () => {
  const assembly = new MessageAssembly()
  const started = assembly.apply({
    type: EventType.TEXT_MESSAGE_START,
    messageId: 'reply',
    role: 'assistant',
    metadata: { source: 'provider', attributes: { citations: ['document-1'] } }
  })
  expect(started).toStrictEqual({
    id: 'reply',
    role: 'assistant',
    content: '',
    metadata: { source: 'provider', attributes: { citations: ['document-1'] } }
  })
  assembly.apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'Answer' })
  assembly.apply({ type: EventType.TEXT_MESSAGE_END, messageId: 'reply' })

  expect(assembly.messages).toStrictEqual([
    {
      id: 'reply',
      role: 'assistant',
      content: 'Answer',
      metadata: { source: 'provider', attributes: { citations: ['document-1'] } }
    }
  ])
})

test('텍스트 종료에만 있는 메타데이터를 해당 메시지에 반영한다', () => {
  const assembly = new MessageAssembly()
  assembly.apply({ type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' })
  assembly.apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'Answer' })
  const ended = assembly.apply({
    type: EventType.TEXT_MESSAGE_END,
    messageId: 'reply',
    metadata: { verified: true, confidence: 0.9 }
  })

  expect(ended).toStrictEqual({
    id: 'reply',
    role: 'assistant',
    content: 'Answer',
    metadata: { verified: true, confidence: 0.9 }
  })
  expect(assembly.messages).toStrictEqual([ended])
})

test('종료 메타데이터는 같은 키를 갱신하고 시작 메타데이터의 다른 키를 보존한다', () => {
  const assembly = new MessageAssembly()
  assembly.apply({
    type: EventType.TEXT_MESSAGE_START,
    messageId: 'reply',
    role: 'assistant',
    metadata: { source: 'provider', progress: 'pending' }
  })
  assembly.apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'Answer' })
  assembly.apply({
    type: EventType.TEXT_MESSAGE_END,
    messageId: 'reply',
    metadata: { progress: 'complete', verified: true }
  })

  expect(assembly.messages).toStrictEqual([
    {
      id: 'reply',
      role: 'assistant',
      content: 'Answer',
      metadata: { source: 'provider', progress: 'complete', verified: true }
    }
  ])
})

test('명시한 부모에 도구 호출을 연결하고 교차하는 호출의 인자와 결과를 보존한다', () => {
  const assembly = new MessageAssembly()
  for (const messageId of ['A', 'B']) {
    assembly.apply({
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: 'assistant',
      metadata: { source: messageId }
    })
    assembly.apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: `Answer ${messageId}` })
  }
  assembly.apply({
    type: EventType.TOOL_CALL_START,
    toolCallId: 'call-A',
    toolCallName: 'lookup',
    parentMessageId: 'A'
  })
  assembly.apply({ type: EventType.TOOL_CALL_START, toolCallId: 'call-B', toolCallName: 'search' })
  assembly.apply({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'call-B', delta: '{"query":"B"}' })
  assembly.apply({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'call-A', delta: '{"id":' })
  assembly.apply({
    type: EventType.TOOL_CALL_RESULT,
    messageId: 'result-B',
    toolCallId: 'call-B',
    content: 'Found B'
  })
  assembly.apply({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'call-A', delta: '1}' })
  assembly.apply({
    type: EventType.TOOL_CALL_RESULT,
    messageId: 'result-A',
    toolCallId: 'call-A',
    content: 'Found A'
  })

  expect(assembly.messages).toStrictEqual([
    {
      id: 'A',
      role: 'assistant',
      content: 'Answer A',
      metadata: { source: 'A' },
      toolCalls: [{ id: 'call-A', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }]
    },
    {
      id: 'B',
      role: 'assistant',
      content: 'Answer B',
      metadata: { source: 'B' },
      toolCalls: [{ id: 'call-B', type: 'function', function: { name: 'search', arguments: '{"query":"B"}' } }]
    },
    { id: 'result-B', role: 'tool', toolCallId: 'call-B', content: 'Found B' },
    { id: 'result-A', role: 'tool', toolCallId: 'call-A', content: 'Found A' }
  ])
})

test('부모의 텍스트 시작이 늦게 와도 먼저 받은 호출과 내용과 메타데이터를 보존한다', () => {
  const assembly = new MessageAssembly()
  assembly.apply({ type: EventType.TEXT_MESSAGE_START, messageId: 'other', role: 'assistant' })
  const started = assembly.apply({
    type: EventType.TOOL_CALL_START,
    toolCallId: 'call',
    toolCallName: 'lookup',
    parentMessageId: 'parent'
  })
  expect(started).toStrictEqual({
    id: 'parent',
    role: 'assistant',
    toolCalls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '' } }]
  })
  assembly.apply({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '{"id":1}' })
  assembly.apply({
    type: EventType.REASONING_ENCRYPTED_VALUE,
    subtype: 'tool-call',
    entityId: 'call',
    encryptedValue: 'signature'
  })
  assembly.apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'parent', delta: 'Before ' })
  assembly.apply({ type: EventType.TEXT_MESSAGE_END, messageId: 'parent', metadata: { verified: true } })
  assembly.apply({
    type: EventType.TEXT_MESSAGE_START,
    messageId: 'parent',
    role: 'assistant',
    metadata: { source: 'provider' }
  })
  assembly.apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'parent', delta: 'after' })
  assembly.apply({
    type: EventType.TOOL_CALL_START,
    toolCallId: 'second',
    toolCallName: 'search',
    parentMessageId: 'parent'
  })
  assembly.apply({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: ' ' })

  expect(assembly.messages).toStrictEqual([
    { id: 'other', role: 'assistant', content: '' },
    {
      id: 'parent',
      role: 'assistant',
      content: 'Before after',
      metadata: { verified: true, source: 'provider' },
      toolCalls: [
        {
          id: 'call',
          type: 'function',
          function: { name: 'lookup', arguments: '{"id":1} ' },
          encryptedValue: 'signature'
        },
        { id: 'second', type: 'function', function: { name: 'search', arguments: '' } }
      ]
    }
  ])
})

test('부모가 없는 도구 호출은 열린 메시지를 재사용하고 결과 이후에는 새 부모를 만든다', () => {
  const assembly = new MessageAssembly()
  assembly.apply({ type: EventType.TOOL_CALL_START, toolCallId: 'first', toolCallName: 'lookup' })
  assembly.apply({ type: EventType.TOOL_CALL_START, toolCallId: 'second', toolCallName: 'search' })
  assembly.apply({ type: EventType.TOOL_CALL_RESULT, messageId: 'result', toolCallId: 'first', content: 'Found' })
  assembly.apply({ type: EventType.TOOL_CALL_START, toolCallId: 'third', toolCallName: 'lookup' })

  expect(assembly.messages).toStrictEqual([
    {
      id: 'first',
      role: 'assistant',
      toolCalls: [
        { id: 'first', type: 'function', function: { name: 'lookup', arguments: '' } },
        { id: 'second', type: 'function', function: { name: 'search', arguments: '' } }
      ]
    },
    { id: 'result', role: 'tool', toolCallId: 'first', content: 'Found' },
    {
      id: 'third',
      role: 'assistant',
      toolCalls: [{ id: 'third', type: 'function', function: { name: 'lookup', arguments: '' } }]
    }
  ])
})

test('어시스턴트가 아닌 메시지를 도구 호출의 부모로 지정하면 기존 메시지를 보존하고 거부한다', () => {
  const assembly = new MessageAssembly()
  assembly.apply({ type: EventType.REASONING_MESSAGE_START, messageId: 'reasoning', role: 'reasoning' })

  expect(() =>
    assembly.apply({
      type: EventType.TOOL_CALL_START,
      toolCallId: 'call',
      toolCallName: 'lookup',
      parentMessageId: 'reasoning'
    })
  ).toThrow('tool call parent is not an assistant message: reasoning')
  expect(assembly.messages).toStrictEqual([{ id: 'reasoning', role: 'reasoning', content: '' }])
})

test('컨텍스트 이벤트를 사용자 메시지로 복구하고 같은 ID의 재생을 중복 저장하지 않는다', () => {
  const assembly = new MessageAssembly()
  const value = { id: 'keundal:context:instructions:one', role: 'user', content: 'Workspace instructions' }
  assembly.apply({ type: EventType.CUSTOM, name: CONTEXT_MESSAGE_EVENT, value })
  assembly.apply({ type: EventType.CUSTOM, name: CONTEXT_MESSAGE_EVENT, value })
  expect(assembly.messages).toEqual([value])
})

test.each([
  { id: 'plain-user', role: 'user', content: 'text' },
  { id: 'keundal:context:spoof', role: 'system', content: 'text' },
  { id: 'keundal:context:spoof', role: 'user', content: 42 }
])('잘못된 컨텍스트 이벤트를 메시지로 기록하지 않는다: %j', (value) => {
  const assembly = new MessageAssembly()
  expect(() => assembly.apply({ type: EventType.CUSTOM, name: CONTEXT_MESSAGE_EVENT, value })).toThrow(
    'invalid context message'
  )
  expect(assembly.messages).toEqual([])
})
