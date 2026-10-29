import { expect, test } from 'vitest'
import type { ChatPart } from '@keundal/chat/chat-message'
import { getMergedParts } from '../app/lib/messages'

test('인접 텍스트를 합쳐도 출처 위치와 순서 및 마지막 스트리밍 상태를 보존하고 원본은 바꾸지 않는다', () => {
  const parts: ChatPart[] = [
    { type: 'source-url', sourceId: 'orphan', url: 'https://ignored.example' },
    { type: 'text', text: '가🌙' },
    { type: 'source-url', sourceId: 'first', url: 'https://first.example' },
    { type: 'source-url', sourceId: 'second', url: 'https://second.example' },
    { type: 'text', text: ' longer', state: 'streaming' },
    { type: 'source-url', sourceId: 'last', url: 'https://last.example' },
    { type: 'reasoning', text: '별도 추론' },
    { type: 'text', text: '다음 문단' }
  ]
  const original = structuredClone(parts)
  expect(getMergedParts(parts)).toEqual([
    {
      type: 'text', text: '가🌙 longer', state: 'streaming',
      sources: [
        { offset: 3, url: 'https://first.example' },
        { offset: 3, url: 'https://second.example' },
        { offset: 10, url: 'https://last.example' }
      ]
    },
    { type: 'reasoning', text: '별도 추론' },
    { type: 'text', text: '다음 문단' }
  ])
  expect(parts).toEqual(original)
})

test('발신 역할이 다른 텍스트는 합치지 않고 같은 역할의 인접 텍스트만 합친다', () => {
  expect(getMergedParts([
    { type: 'text', text: 'assistant' },
    { type: 'text', role: 'user', text: 'user ' },
    { type: 'text', role: 'user', text: 'continued' },
    { type: 'text', role: 'developer', text: 'instructions' },
    { type: 'text', text: 'answer' }
  ])).toEqual([
    { type: 'text', text: 'assistant' },
    { type: 'text', role: 'user', text: 'user continued', sources: undefined },
    { type: 'text', role: 'developer', text: 'instructions' },
    { type: 'text', text: 'answer' }
  ])
})
