import { expect, test } from 'vitest'

import type { ChatMessage } from '../src/chat-message'
import type { LocalChat } from '../src/chat-store'
import { ChatRuns, createActiveChatRun, type ChatRunStorage } from '../src/run-queue'

const threadId = 'chat'

const message: ChatMessage = {
  id: 'queued',
  role: 'user',
  parts: [{ type: 'text', text: '다음 질문' }]
}

const chat = (queue?: ChatMessage[]): LocalChat => ({
  id: threadId,
  title: null,
  createdAt: '2026-11-08T00:00:00.000Z',
  messages: [],
  votes: [],
  model: 'test/model',
  started: true,
  isOwner: true,
  visibility: 'private',
  ...(queue === undefined ? {} : { queue })
})

function fixture(initial: LocalChat = chat()) {
  let saved = initial
  const storage: ChatRunStorage = {
    read: async () => saved,
    write: async (_id, change) => {
      saved = change(saved)
      return saved
    }
  }
  return { runs: new ChatRuns(storage), saved: () => saved }
}

test('같은 id의 동시 Steer가 실패하면 두 요청 모두 실패를 반환하고 재시도할 수 있다', async () => {
  const { runs } = fixture()
  const run = createActiveChatRun(new AbortController(), Promise.resolve())
  run.runId = 'run'
  runs.active.set(threadId, run)
  const pending = Promise.withResolvers<boolean>()
  let calls = 0
  const deliver = async () => {
    calls++
    return pending.promise
  }

  const first = runs.steer(threadId, message, deliver)
  const duplicate = runs.steer(threadId, message, deliver)
  expect(calls).toBe(1)
  pending.resolve(false)

  await expect(Promise.all([first, duplicate])).resolves.toEqual([false, false])
  expect(run.submitted).toEqual([])
  expect(run.submitting.size).toBe(0)
  await expect(runs.steer(threadId, message, async () => true)).resolves.toBe(true)
  expect(run.submitted.map((submitted) => submitted.id)).toEqual([message.id])
})

test('같은 id의 동시 Steer가 성공하면 두 요청에 결과를 공유하고 한 번만 전달한다', async () => {
  const { runs } = fixture()
  const run = createActiveChatRun(new AbortController(), Promise.resolve())
  run.runId = 'run'
  runs.active.set(threadId, run)
  const pending = Promise.withResolvers<boolean>()
  let calls = 0
  const deliver = async () => {
    calls++
    return pending.promise
  }

  const first = runs.steer(threadId, message, deliver)
  const duplicate = runs.steer(threadId, message, deliver)
  pending.resolve(true)

  await expect(Promise.all([first, duplicate])).resolves.toEqual([true, true])
  expect(calls).toBe(1)
  expect(run.submitted.map((submitted) => submitted.id)).toEqual([message.id])
  expect(run.submitting.size).toBe(0)
  await expect(runs.steer(threadId, message, deliver)).resolves.toBe(true)
  expect(calls).toBe(1)
})

test('Steer 전달 중 예외가 발생해도 기록을 되돌리고 재시도를 허용한다', async () => {
  const { runs } = fixture()
  const run = createActiveChatRun(new AbortController(), Promise.resolve())
  run.runId = 'run'
  runs.active.set(threadId, run)
  const pending = Promise.withResolvers<boolean>()
  const first = runs.steer(threadId, message, () => pending.promise)
  const duplicate = runs.steer(threadId, message, () => pending.promise)
  pending.reject(new Error('network failed'))
  const results = await Promise.allSettled([first, duplicate])

  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect(run.submitted).toEqual([])
  expect(run.submitting.size).toBe(0)
  await expect(runs.steer(threadId, message, async () => true)).resolves.toBe(true)
})

test('Queue 취소의 저장소 조회 중 실행이 종료되어도 최신 저장소에 삭제를 적용한다', async () => {
  let saved = chat([message])
  const readStarted = Promise.withResolvers<void>()
  const resumeRead = Promise.withResolvers<void>()
  const runs = new ChatRuns({
    read: async () => {
      readStarted.resolve()
      await resumeRead.promise
      return saved
    },
    write: async (_id, change) => {
      saved = change(saved)
      return saved
    }
  })
  const finished = Promise.withResolvers<void>()
  const run = createActiveChatRun(new AbortController(), finished.promise)
  run.runId = 'run'
  runs.active.set(threadId, run)

  const removing = runs.dequeue(threadId, message.id)
  await readStarted.promise
  // 종료 커밋이 실행 객체를 해제했지만 read는 이전 실행 객체에 대한 응답을 돌려줍니다.
  run.closing = true
  runs.active.delete(threadId)
  finished.resolve()
  resumeRead.resolve()

  await expect(removing).resolves.toEqual([])
  expect(saved.queue).toBeUndefined()
  // 네트워크 재시도처럼 같은 삭제를 반복해도 Queue는 되살아나지 않습니다.
  await expect(runs.dequeue(threadId, message.id)).resolves.toEqual([])
  expect(saved.queue).toBeUndefined()
})

test('실행 중 Queue 취소는 커밋 전에는 메모리에만 반영하고 종료 후에도 유지한다', async () => {
  const { runs, saved } = fixture(chat([message]))
  const finished = Promise.withResolvers<void>()
  const run = createActiveChatRun(new AbortController(), finished.promise)
  run.runId = 'run'
  runs.active.set(threadId, run)

  await expect(runs.dequeue(threadId, message.id)).resolves.toEqual([])
  expect(saved().queue?.map((entry) => entry.id)).toEqual([message.id])
  expect(run.removed.has(message.id)).toBe(true)
  await runs.release(threadId, run, false)
  finished.resolve()
  expect(saved().queue).toBeUndefined()
})
