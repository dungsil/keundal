import { expect, test } from 'vitest'

import {
  chatPath,
  settingsReturnTo,
  historyQuery,
  historySort,
  searchChatHistory,
  sidebarChats
} from '../app/utils/chat-navigation'

const chats = Array.from({ length: 1000 }, (_, index) => ({
  id: String(index),
  label: `대화 ${index}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
})).reverse()

test('사이드바는 표시 한도를 유지하면서 오래된 현재 대화도 포함한다', () => {
  const visible = sidebarChats(chats, 40, '0')
  expect(visible).toHaveLength(40)
  expect(visible.at(-1)?.id).toBe('0')
  expect(new Set(visible.map((chat) => chat.id)).size).toBe(40)
  expect(sidebarChats(chats, 80, '0')).toHaveLength(80)
  expect(sidebarChats([], 40, 'missing')).toEqual([])
})

test('전체 기록 검색은 사이드바 밖의 제목을 찾고 정렬해도 원본을 변경하지 않는다', () => {
  const original = chats.map((chat) => chat.id)
  expect(searchChatHistory(chats, '대화 0', 'newest').map((chat) => chat.id)).toEqual(['0'])
  expect(searchChatHistory(chats, '', 'oldest')[0]?.id).toBe('0')
  expect(searchChatHistory(chats, '', 'newest')[0]?.id).toBe('999')
  expect(chats.map((chat) => chat.id)).toEqual(original)
})

test('잘못된 URL 검색 값은 안전한 기본값으로 처리한다', () => {
  expect(historyQuery(['secret', 'other'])).toBe('')
  expect(historyQuery('검색')).toBe('검색')
  expect(historySort('oldest')).toBe('oldest')
  expect(historySort(['oldest'])).toBe('newest')
  expect(historySort('unknown')).toBe('newest')
})

test('대화 ID의 구분 문자는 단일 경로 세그먼트로 인코딩한다', () => {
  for (const id of ['a/b', 'a?b', 'a#b', '한글 %']) {
    const path = chatPath(id)
    expect(path).toBe(`/chat/${encodeURIComponent(id)}`)
    expect(decodeURIComponent(path.slice('/chat/'.length))).toBe(id)
    expect(new URL(path, 'https://example.test').search).toBe('')
    expect(new URL(path, 'https://example.test').hash).toBe('')
  }
})

test('설정 돌아가기 경로는 기록과 기존 대화 경로만 허용한다', () => {
  expect(settingsReturnTo('/history')).toBe('/history')
  expect(settingsReturnTo(chatPath('a/#?'))).toBe('/chat/a%2F%23%3F')
  for (const path of [
    '/history?redirect=//evil.test',
    '/history/other',
    '//evil.test',
    'https://evil.test',
    '/chat/a/b',
    ['/history'],
    undefined
  ]) {
    expect(settingsReturnTo(path)).toBe('/')
  }
})
