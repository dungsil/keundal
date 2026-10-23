import { expect, test } from 'vitest'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { TRANSCRIPT_PAGE_SIZE, transcriptStart, anchoredTranscriptStart, countToReveal, messageAnchor, messageIdFromHash, messagePermalink, chatMarkdown } from '../shared/utils/chat-transcript'

const messages: ChatMessage[] = Array.from({ length: 125 }, (_, index) => ({
  id: `m-${index}`, role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `내용 ${index}` }]
}))

test('최근 화면 범위만 제한하고 전체 대화 원본은 보존한다', () => {
  const start = transcriptStart(messages.length, TRANSCRIPT_PAGE_SIZE)
  expect(start).toBe(85)
  expect(messages.slice(start)).toHaveLength(40)
  expect(messages).toHaveLength(125)
  expect(transcriptStart(0, 40)).toBe(0)
  expect(transcriptStart(12, 40)).toBe(0)
  expect(transcriptStart(125, 80)).toBe(45)
})

test('오래된 링크 대상까지 펼치고 없거나 이미 보이는 대상은 범위를 유지한다', () => {
  expect(countToReveal(messages, 40, 'm-4')).toBe(121)
  expect(countToReveal(messages, 40, 'm-124')).toBe(40)
  expect(countToReveal(messages, 40, 'missing')).toBe(40)
  expect(countToReveal(messages, 160, 'm-4')).toBe(160)
})

test('특수문자 메시지 링크는 기존 경로와 쿼리를 보존하며 해시만 교체한다', () => {
  const id = '한 글# /?%"[]'
  const link = new URL(messagePermalink('https://example.com/chat/123?view=full#old', id))
  expect(link.pathname).toBe('/chat/123')
  expect(link.search).toBe('?view=full')
  expect(link.hash).toBe(`#${messageAnchor(id)}`)
  expect(messageIdFromHash(link.hash)).toBe(id)
  expect(messageIdFromHash('#message-%zz')).toBeUndefined()
  expect(messageIdFromHash('#other')).toBeUndefined()
})

test('Markdown은 숨겨진 메시지와 본문 서식을 보존하고 내부 실행 데이터와 첨부 URL은 제외한다', () => {
  const full: ChatMessage[] = [...messages, {
    id: 'last', role: 'assistant', parts: [
      { type: 'text', text: '**서식**\n\n```ts\nconst a = 1\n```' },
      { type: 'file', filename: 'file[1].png', mediaType: 'image/png', url: 'https://example.com/private?token=secret' },
      { type: 'reasoning', text: '비공개 추론' },
      { type: 'data-keundal', data: { model: 'internal', messages: [] } }
    ]
  }]
  const markdown = chatMarkdown('제목\n# 주입', full)
  expect(markdown).toContain('내용 0')
  expect(markdown).toContain('내용 124')
  expect(markdown).toContain('**서식**\n\n```ts\nconst a = 1\n```')
  expect(markdown).toContain('Attachment: file\\[1\\].png')
  expect(markdown).not.toContain('secret')
  expect(markdown).not.toContain('비공개 추론')
  expect(markdown).not.toContain('internal')
  expect(markdown).toMatch(/^# 제목 \\# 주입\n/)
})

for (const [label, count, anchorId] of [
  ['이전 기록', 80, 'm-45'],
  ['메시지 링크', 121, 'm-4'],
  ['편집기', 40, 'm-85']
] as const) {
  test(`${label}를 연 뒤 메시지가 추가되어도 첫 표시 메시지와 원본은 유지한다`, () => {
    const original = structuredClone(messages)
    const start = anchoredTranscriptStart(messages, count, anchorId)
    const appended: ChatMessage[] = [...messages, { id: 'new', role: 'assistant', parts: [{ type: 'text', text: '새 응답' }] }]
    const nextStart = anchoredTranscriptStart(appended, count, anchorId)
    expect(nextStart).toBe(start)
    expect(appended.slice(nextStart)[0]?.id).toBe(anchorId)
    expect(appended.slice(nextStart).at(-1)?.id).toBe('new')
    expect(messages).toEqual(original)
  })
}

test('기록을 펼치지 않았으면 새 메시지 이후에도 최근 40개만 표시한다', () => {
  const appended: ChatMessage[] = [...messages, { id: 'new', role: 'assistant', parts: [] }]
  expect(anchoredTranscriptStart(appended, 40)).toBe(86)
  expect(appended.slice(anchoredTranscriptStart(appended, 40))).toHaveLength(40)
})

test('대화 잘라내기로 표시 기준 메시지가 사라지면 남은 최근 기록을 표시한다', () => {
  const truncated = messages.slice(0, 20)
  expect(anchoredTranscriptStart(truncated, 40, 'm-85')).toBe(0)
  expect(anchoredTranscriptStart([], 40, 'm-85')).toBe(0)
})
