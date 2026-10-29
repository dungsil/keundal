import {
  CONTEXT_MESSAGE_EVENT,
  EventType,
  EventNormalizer,
  MessageAssembly,
  mergeMessages,
  normalizeEvents,
  prepareReplayMessages,
  type AGUIEvent,
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

test('텍스트의 역할과 메시지·도구 호출별 metadata를 얕게 병합하고 마지막 값을 보존한다', () => {
  const assembly = new MessageAssembly()
  for (const role of ['user', 'system', 'developer', 'assistant'] as const) {
    assembly.apply({
      type: EventType.TEXT_MESSAGE_START,
      messageId: role,
      role,
      metadata: { keep: role, stage: 'start', nested: { old: true } }
    })
    assembly.apply({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: role,
      delta: `${role} text`,
      metadata: { stage: 'content', nested: { new: true } }
    })
    assembly.apply({ type: EventType.TEXT_MESSAGE_END, messageId: role, metadata: { ended: null } })
  }
  assembly.apply({
    type: EventType.REASONING_MESSAGE_START,
    messageId: 'reason',
    role: 'reasoning',
    metadata: { keep: true }
  })
  assembly.apply({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: 'reason',
    delta: 'summary',
    metadata: { stage: 'content' }
  })
  assembly.apply({ type: EventType.REASONING_MESSAGE_END, messageId: 'reason', metadata: { stage: 'end' } })
  assembly.apply({
    type: EventType.TOOL_CALL_START,
    toolCallId: 'call',
    toolCallName: 'lookup',
    parentMessageId: 'assistant',
    metadata: { keep: 'call', stage: 'start' }
  })
  assembly.apply({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: 'call',
    delta: '{}',
    metadata: { stage: 'args', nested: { old: true } }
  })
  assembly.apply({ type: EventType.TOOL_CALL_END, toolCallId: 'call', metadata: { nested: { new: true } } })
  assembly.apply({
    type: EventType.TOOL_CALL_RESULT,
    toolCallId: 'call',
    messageId: 'result',
    content: 'found',
    metadata: { result: true }
  })
  expect(assembly.messages.slice(0, 4).map(({ id, role, metadata }) => ({ id, role, metadata }))).toEqual(
    ['user', 'system', 'developer', 'assistant'].map((role) => ({
      id: role,
      role,
      metadata: { keep: role, stage: 'content', nested: { new: true }, ended: null }
    }))
  )
  expect(assembly.messages[3]).toMatchObject({
    toolCalls: [{ metadata: { keep: 'call', stage: 'args', nested: { new: true } } }]
  })
  expect(assembly.messages[4]).toEqual({
    id: 'reason',
    role: 'reasoning',
    content: 'summary',
    metadata: { keep: true, stage: 'end' }
  })
  expect(assembly.messages[5]).toEqual({
    id: 'result',
    role: 'tool',
    toolCallId: 'call',
    content: 'found',
    metadata: { result: true }
  })
})

test('CHUNK의 생략된 ID와 역할·metadata를 복원하고 종류가 바뀌거나 실행이 끝나면 닫는다', async () => {
  const chunks: AGUIEvent[] = [
    {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: 'instruction',
      role: 'developer',
      name: 'policy',
      delta: 'Do ',
      metadata: { keep: true }
    },
    { type: EventType.TEXT_MESSAGE_CHUNK, delta: 'this' },
    { type: EventType.TEXT_MESSAGE_CHUNK, metadata: { last: null } },
    { type: EventType.REASONING_MESSAGE_CHUNK, messageId: 'reason', delta: 'Check' },
    { type: EventType.REASONING_MESSAGE_CHUNK, delta: ' first', metadata: { reason: true } },
    {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: 'call',
      toolCallName: 'lookup',
      delta: '{"city":',
      metadata: { stage: 1 }
    },
    { type: EventType.TOOL_CALL_CHUNK, delta: '"Seoul"}', metadata: { stage: 2 } },
    { type: EventType.TOOL_CALL_RESULT, toolCallId: 'call', messageId: 'result', content: 'found' },
    { type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'reply', delta: 'Done', rawEvent: { provider: 'payload' } },
    { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run' }
  ]
  const assembly = new MessageAssembly()
  for (const chunk of chunks) assembly.apply(chunk)
  expect(assembly.messages).toEqual([
    { id: 'instruction', role: 'developer', name: 'policy', content: 'Do this', metadata: { keep: true, last: null } },
    { id: 'reason', role: 'reasoning', content: 'Check first', metadata: { reason: true } },
    {
      id: 'call',
      role: 'assistant',
      toolCalls: [
        {
          id: 'call',
          type: 'function',
          function: { name: 'lookup', arguments: '{"city":"Seoul"}' },
          metadata: { stage: 2 }
        }
      ]
    },
    { id: 'result', role: 'tool', toolCallId: 'call', content: 'found' },
    { id: 'reply', role: 'assistant', content: 'Done' }
  ])
  const events = await Array.fromAsync(
    normalizeEvents(
      (async function* () {
        yield* chunks
      })()
    )
  )
  expect(events.map((event) => event.type)).toEqual([
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'REASONING_MESSAGE_START',
    'REASONING_MESSAGE_CONTENT',
    'REASONING_MESSAGE_CONTENT',
    'REASONING_MESSAGE_END',
    'TOOL_CALL_START',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_END',
    'TOOL_CALL_RESULT',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'RUN_FINISHED'
  ])
  expect(
    events.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT && event.messageId === 'reply')
  ).toMatchObject({ rawEvent: { provider: 'payload' } })
  expect(events.filter((event) => event.type.endsWith('_END')).every((event) => event.metadata === undefined)).toBe(
    true
  )
})

test('서브에이전트 CHUNK를 교차 수신해도 다른 스트림을 닫지 않고 중단 뒤 이어 붙인다', () => {
  const normalizer = new EventNormalizer()
  normalizer.apply({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'a', subagentRunId: 'child-a', delta: 'A' })
  normalizer.apply({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'b', subagentRunId: 'child-b', delta: 'B' })
  expect(() => normalizer.apply({ type: EventType.TEXT_MESSAGE_CHUNK, delta: '?' })).toThrow('ambiguous')
  expect(normalizer.apply({ type: EventType.RAW, event: 'side channel' })).toHaveLength(1)
  expect(normalizer.apply({ type: EventType.TEXT_MESSAGE_CHUNK, subagentRunId: 'child-a', delta: '2' })).toEqual([
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', subagentRunId: 'child-a', delta: '2' }
  ])
  expect(() => normalizer.apply({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'a', role: 'user' })).toThrow(
    'changes'
  )
  expect(normalizer.finish()).toEqual([
    { type: EventType.TEXT_MESSAGE_END, messageId: 'a', subagentRunId: 'child-a' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'b', subagentRunId: 'child-b' }
  ])
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
