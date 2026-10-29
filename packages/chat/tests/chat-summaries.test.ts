import { listChatSummaries, type LocalChat } from '@keundal/chat/chat-store'
import { expect, test } from 'vitest'

test('요약 기능이 없는 저장소에서도 메시지 없이 목록을 반환한다', async () => {
  const chat: LocalChat = {
    id: 'chat',
    title: null,
    createdAt: '2026-10-23',
    messages: [],
    votes: [],
    model: 'model',
    started: true,
    isOwner: true,
    visibility: 'private'
  }
  expect(await listChatSummaries({ list: async () => [chat] })).toEqual([
    { id: 'chat', title: null, createdAt: '2026-10-23' }
  ])
})

test('요약 기능이 있으면 전체 목록을 읽지 않는다', async () => {
  expect(
    await listChatSummaries({
      list: async () => {
        throw new Error('Full list must not be loaded')
      },
      listSummaries: async () => [{ id: 'chat', title: 'title', createdAt: '2026-10-23' }]
    })
  ).toEqual([{ id: 'chat', title: 'title', createdAt: '2026-10-23' }])
})
