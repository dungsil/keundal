import { EventType, MessageAssembly, mergeMessages, prepareReplayMessages, type AgentMessage } from '@keundal/core'
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
