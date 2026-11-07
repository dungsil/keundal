import type { ChatMessage } from '../src/chat-message'
import type { LocalChat } from '../src/chat-store'
import { ChatRuns, createActiveChatRun } from '../src/run-queue'
import { expect, test } from 'vitest'

const message = (id: string): ChatMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text: id }]
})

function fixture() {
  let saved: LocalChat = {
    id: 'thread',
    title: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [message('first')],
    votes: [],
    model: 'test',
    started: true,
    isOwner: true,
    visibility: 'private',
    queue: [message('queued')]
  }
  let read: () => Promise<LocalChat | undefined> = async () => saved
  const runs = new ChatRuns({
    read: () => read(),
    write: async (_id, change) => {
      saved = change(saved)
      return saved
    }
  })
  return {
    runs,
    get saved() {
      return saved
    },
    setRead(fn: () => Promise<LocalChat | undefined>) {
      read = fn
    }
  }
}

test('중복 Steer는 실제 전달 실패를 공유하고 재시도하면 다시 전달한다', async () => {
  const { runs } = fixture()
  const done = Promise.withResolvers<void>()
  const run = { ...createActiveChatRun(new AbortController(), done.promise), runId: 'run' }
  runs.active.set('thread', run)
  const response = Promise.withResolvers<boolean>()
  let delivered = 0
  const deliver = async () => {
    delivered++
    return response.promise
  }

  const first = runs.steer('thread', message('steer'), deliver)
  const duplicate = runs.steer('thread', message('steer'), deliver)
  expect(delivered).toBe(1)
  response.resolve(false)
  expect(await Promise.all([first, duplicate])).toEqual([false, false])
  expect(run.submitted).toEqual([])

  const retried = await runs.steer('thread', message('steer'), async () => {
    delivered++
    return true
  })
  expect(retried).toBe(true)
  expect(delivered).toBe(2)
  expect(run.submitted.map((item) => item.id)).toEqual(['steer'])
  done.resolve()
})

test('중복 Steer는 예외 결과를 공유하고 다음 재시도를 허용한다', async () => {
  const { runs } = fixture()
  const done = Promise.withResolvers<void>()
  const run = { ...createActiveChatRun(new AbortController(), done.promise), runId: 'run' }
  runs.active.set('thread', run)
  const response = Promise.withResolvers<boolean>()
  let delivered = 0
  const deliver = async () => {
    delivered++
    return response.promise
  }

  const first = runs.steer('thread', message('steer'), deliver)
  const duplicate = runs.steer('thread', message('steer'), deliver)
  response.reject(new Error('delivery failed'))
  const results = await Promise.allSettled([first, duplicate])
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect(delivered).toBe(1)
  expect(run.submitted).toEqual([])
  expect(await runs.steer('thread', message('steer'), async () => true)).toBe(true)
  done.resolve()
})

test('저장소 읽기 도중 종료된 실행의 Queue 취소는 최신 저장소에 반영한다', async () => {
  const fixtureState = fixture()
  const { runs } = fixtureState
  const done = Promise.withResolvers<void>()
  const run = createActiveChatRun(new AbortController(), done.promise)
  runs.active.set('thread', run)
  const reading = Promise.withResolvers<LocalChat | undefined>()
  const readingStarted = Promise.withResolvers<void>()
  let readCount = 0
  fixtureState.setRead(() => {
    readCount++
    if (readCount === 1) {
      readingStarted.resolve()
      return reading.promise
    }
    return Promise.resolve(fixtureState.saved)
  })
  const removing = runs.dequeue('thread', 'queued')
  await readingStarted.promise
  run.closing = true
  runs.active.delete('thread')
  done.resolve()
  reading.resolve(fixtureState.saved)
  expect(await removing).toEqual([])
  expect(fixtureState.saved.queue).toBeUndefined()
  expect(readCount).toBe(2)
})
