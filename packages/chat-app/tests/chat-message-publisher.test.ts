import { EventType } from '@keundal/core'
import { afterEach, expect, test, vi } from 'vitest'
import { ChatMessageAssembly, type ChatMessage } from '../shared/utils/chat-message'
import { ChatMessagePublisher } from '../shared/utils/chat-message-publisher'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test.each(['text', 'reasoning'] as const)('%s의 느린 작은 델타도 누적 복사 예산을 넘지 않는다', (kind) => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now += 100)
  function run(count: number) {
    const assembly = new ChatMessageAssembly('run')
    let copied = 0
    let updates = 0
    const publisher = new ChatMessagePublisher((message) => {
      copied += JSON.stringify(message).length
      updates++
    })
    assembly.apply(kind === 'text'
      ? { type: EventType.TEXT_MESSAGE_START, messageId: 'message', role: 'assistant' }
      : { type: EventType.REASONING_MESSAGE_START, messageId: 'message', role: 'reasoning' })
    for (let i = 0; i < count; i++) {
      const event = { type: kind === 'text' ? EventType.TEXT_MESSAGE_CONTENT : EventType.REASONING_MESSAGE_CONTENT, messageId: 'message', delta: '가' } as const
      assembly.apply(event)
      publisher.update(event, assembly.message)
    }
    publisher.finish(assembly.message)
    expect(updates).toBeLessThan(10_000)
    return copied
  }
  const small = run(10_000)
  const large = run(20_000)
  expect(small).toBeLessThan(16 * 1024 * 1024 + 20_000)
  expect(large).toBeLessThan(16 * 1024 * 1024 + 40_000)
})

test('빠른 델타는 합치고 취소된 부분 응답과 재생 데이터를 마지막에 빠짐없이 알린다', () => {
  vi.spyOn(performance, 'now').mockReturnValue(0)
  const assembly = new ChatMessageAssembly('run')
  const snapshots: ChatMessage[] = []
  const publisher = new ChatMessagePublisher(message => snapshots.push(message))
  const start = { type: EventType.TEXT_MESSAGE_START, messageId: 'message', role: 'assistant' } as const
  assembly.apply(start)
  publisher.update(start, assembly.message)
  for (let i = 0; i < 10_000; i++) {
    const event = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message', delta: 'a' } as const
    assembly.apply(event)
    publisher.update(event, assembly.message)
  }
  expect(snapshots).toHaveLength(2)
  expect(snapshots[0]!.parts).toEqual([{ type: 'text', text: '', state: 'streaming' }])
  assembly.finish('openai/gpt-5-nano')
  publisher.finish(assembly.message)
  expect(snapshots).toHaveLength(3)
  expect(snapshots[2]!.parts[0]).toEqual({ type: 'text', text: 'a'.repeat(10_000) })
  expect(snapshots[2]!.parts.at(-1)?.type).toBe('data-keundal')
  expect(snapshots[0]!.parts).toEqual([{ type: 'text', text: '', state: 'streaming' }])
})

test('느린 일반 응답은 진행 상태를 알리고 이전 스냅샷을 변경하지 않는다', () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now += 100)
  const snapshots: ChatMessage[] = []
  const publisher = new ChatMessagePublisher(message => snapshots.push(message))
  const message: ChatMessage = { id: 'run', role: 'assistant', parts: [] }
  for (let i = 0; i < 30; i++) {
    message.parts = [{ type: 'text', text: 'hello '.repeat(i + 1) }]
    publisher.update({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message', delta: 'hello ' }, message)
  }
  publisher.finish(message)
  expect(snapshots.length).toBeGreaterThan(5)
  expect(snapshots[0]!.parts).toEqual([{ type: 'text', text: 'hello ' }])
  expect(snapshots.at(-1)).toEqual(message)
})

test('도구 실행이나 다음 델타 전에 공급자가 멈춰도 대기 중인 화면 상태를 알린다', () => {
  vi.useFakeTimers()
  const snapshots: ChatMessage[] = []
  const publisher = new ChatMessagePublisher(message => snapshots.push(message))
  const assembly = new ChatMessageAssembly('run')
  const start = { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' } as const
  assembly.apply(start)
  publisher.update(start, assembly.message)
  const tool = { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'search' } as const
  assembly.apply(tool)
  publisher.update(tool, assembly.message)
  vi.advanceTimersByTime(50)
  expect(snapshots.at(-1)!.parts).toContainEqual({ type: 'tool-search', toolCallId: 'call', state: 'input-streaming' })
  assembly.finish('openai/gpt-5-nano')
  publisher.finish(assembly.message)
  const count = snapshots.length
  vi.advanceTimersByTime(100)
  expect(snapshots).toHaveLength(count)
})
