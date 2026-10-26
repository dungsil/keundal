import { mountAgent } from './fixtures/agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { EventType, type AGUIEvent } from '@keundal/core'
import { LLMService, type LLMRequest, type LLMEvent } from '@keundal/llm'
import { IDBFactory } from 'fake-indexeddb'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { expect, onTestFinished, test } from 'vitest'
import { ChatStore } from '@keundal/plugin-chat-local'

const model = 'openai/gpt-5-nano'
const backends = ['memory', 'indexeddb', 'sqlite'] as const
const first: ChatMessage = { id: 'first', role: 'user', parts: [{ type: 'text', text: '첫 질문' }] }
const second: ChatMessage = { id: 'second', role: 'user', parts: [{ type: 'text', text: '둘째 질문' }] }

async function collect(events: AsyncIterable<AGUIEvent>) {
  const result: AGUIEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

async function setup(backend: (typeof backends)[number], script?: (request: LLMRequest) => Promise<void>) {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class ScriptedLLM extends LLMService {
    async getModel() { return { contextWindow: 128_000, maxOutputTokens: 4096 } }
    async countTokens() { return 40 }
    async* stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      const title = request.input.messages.some(message => message.role === 'system' && message.content.startsWith('Generate a chat title'))
      if (!title) {
        requests.push(request)
        await script?.(request)
      }
      const messageId = crypto.randomUUID()
      yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' as const }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: title ? '분기 제목' : `응답 ${requests.length}` }
      yield { type: EventType.TEXT_MESSAGE_END, messageId }
    }
  }
  const llm = ctx.plugin(ScriptedLLM)
  await llm
  const directory = await mkdtemp(join(tmpdir(), 'keundal-branch-'))
  const store = backend === 'memory'
    ? ctx.plugin(memoryStorePlugin)
    : backend === 'sqlite'
      ? ctx.plugin(sqliteStorePlugin, { path: join(directory, 'chat.sqlite') })
      : ctx.plugin(indexedDBStorePlugin, { indexedDB: new IDBFactory(), databaseName: crypto.randomUUID(), locks: navigator.locks })
  await store
  const chats = new ChatStore(ctx, mountAgent)
  onTestFinished(async () => {
    await chats.stop()
    await store.dispose()
    await llm.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { ctx, chats, requests }
}

/** 질문 두 개와 응답 두 개를 가진 대화를 만들고 첫 응답에 투표합니다. */
async function twoTurns(chats: ChatStore) {
  await chats.create('chat', first, model)
  await collect(chats.respond('chat', { model, messages: [first] }))
  const afterFirst = (await chats.get('chat'))!
  await collect(chats.respond('chat', { model, messages: [...afterFirst.messages, second] }))
  const original = (await chats.get('chat'))!
  await chats.vote('chat', original.messages[1]!.id, true)
  await chats.vote('chat', original.messages[3]!.id, false)
  return (await chats.get('chat'))!
}

test.each(backends)('%s 저장소에서 어시스턴트 메시지로 분기하면 그 메시지까지 복사한 새 대화가 생기고 원래 대화는 그대로다', async (backend) => {
  const { ctx, chats } = await setup(backend)
  const original = await twoTurns(chats)
  const revision = (await ctx.session.get('chat'))!.revision
  await chats.enqueue('chat', { id: 'queued', role: 'user', parts: [{ type: 'text', text: '대기 질문' }] })
  const withQueue = (await chats.get('chat'))!
  const queuedRevision = (await ctx.session.get('chat'))!.revision

  const branched = await chats.branch('chat', original.messages[1]!.id, 'branch')

  expect(branched).toMatchObject({
    id: 'branch',
    title: original.title,
    model: original.model,
    started: true,
    isOwner: true,
    visibility: 'private'
  })
  expect(branched.messages).toEqual(original.messages.slice(0, 2))
  expect(branched.messages).not.toBe(original.messages)
  expect(branched.votes).toEqual([{ chatId: 'branch', messageId: original.messages[1]!.id, isUpvoted: true }])
  expect(branched.queue).toBeUndefined()
  expect(branched.pendingRunId).toBeUndefined()
  expect(new Date(branched.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(original.createdAt).getTime())
  expect(await chats.get('branch')).toEqual(branched)
  expect((await chats.list()).map(chat => chat.id)).toEqual(expect.arrayContaining(['chat', 'branch']))

  expect(await chats.get('chat')).toEqual(withQueue)
  expect(withQueue.queue).toHaveLength(1)
  expect((await ctx.session.get('chat'))!.revision).toBe(queuedRevision)
  expect(queuedRevision).toBeGreaterThan(revision)
})

test.each(backends)('%s 저장소에서 사용자 메시지로 분기하면 그 질문까지만 복사하고 투표는 남기지 않는다', async (backend) => {
  const { chats } = await setup(backend)
  const original = await twoTurns(chats)

  const branched = await chats.branch('chat', first.id, 'branch')

  expect(branched.messages).toEqual([first])
  expect(branched.votes).toEqual([])
  expect(branched.started).toBe(true)
  expect((await chats.get('chat'))!.messages).toEqual(original.messages)
})

test.each(backends)('%s 저장소에서 분기한 대화가 응답을 받아도 원래 대화의 revision과 메시지는 바뀌지 않는다', async (backend) => {
  const { ctx, chats, requests } = await setup(backend)
  const original = await twoTurns(chats)
  const snapshot = (await ctx.session.get('chat'))!

  const branched = await chats.branch('chat', original.messages[1]!.id, 'branch')
  const followUp: ChatMessage = { id: 'follow-up', role: 'user', parts: [{ type: 'text', text: '다른 질문' }] }
  await collect(chats.respond('branch', { model, messages: [...branched.messages, followUp] }))

  const grown = (await chats.get('branch'))!
  expect(grown.messages).toHaveLength(4)
  expect(grown.messages.slice(0, 2)).toEqual(original.messages.slice(0, 2))
  expect(JSON.stringify(requests.at(-1))).not.toContain('둘째 질문')
  expect(await ctx.session.get('chat')).toEqual(snapshot)
})

test.each(backends)('%s 저장소에서 원래 대화를 지워도 분기한 대화는 남고 복사한 응답의 실행 기록은 없음으로 조회된다', async (backend) => {
  const { ctx, chats } = await setup(backend)
  const original = await twoTurns(chats)
  const runId = original.messages[1]!.id
  const branched = await chats.branch('chat', runId, 'branch')
  expect(await chats.getRun(runId)).toMatchObject({ status: 'completed' })

  await chats.delete('chat')

  expect(await chats.get('chat')).toBeUndefined()
  expect(await chats.get('branch')).toEqual(branched)
  expect((await chats.list()).map(chat => chat.id)).toEqual(['branch'])
  expect(await chats.getRun(runId)).toBeUndefined()
  expect((await ctx.generation.list()).map(run => run.request.input.runId)).not.toContain(runId)
})

test.each(backends)('%s 저장소에서 잘못된 분기 요청은 새 대화를 만들지 않고 거부한다', async (backend) => {
  const { chats } = await setup(backend)
  await twoTurns(chats)

  await expect(chats.branch('chat', 'missing', 'branch')).rejects.toThrow('Invalid message')
  await expect(chats.branch('missing', 'first', 'branch')).rejects.toThrow('Chat not found')
  await expect(chats.branch('chat', 'first', 'chat')).rejects.toThrow('Chat already exists')
  expect(await chats.get('branch')).toBeUndefined()
  expect((await chats.list()).map(chat => chat.id)).toEqual(['chat'])
})

test.each(backends)('%s 저장소에서 응답이 실행 중이어도 분기하고 원래 실행은 그대로 끝난다', async (backend) => {
  const gate = Promise.withResolvers<void>()
  const running = Promise.withResolvers<void>()
  const { chats } = await setup(backend, async (request) => {
    if (JSON.stringify(request.input).includes('둘째 질문')) {
      running.resolve()
      await gate.promise
    }
  })
  await chats.create('chat', first, model)
  await collect(chats.respond('chat', { model, messages: [first] }))
  const afterFirst = (await chats.get('chat'))!
  const response = collect(chats.respond('chat', { model, messages: [...afterFirst.messages, second] }))
  await running.promise
  expect((await chats.get('chat'))!.pendingRunId).toBeDefined()

  const branched = await chats.branch('chat', afterFirst.messages[1]!.id, 'branch')
  gate.resolve()
  await response

  expect(branched.messages).toEqual(afterFirst.messages)
  expect(branched.pendingRunId).toBeUndefined()
  const finished = (await chats.get('chat'))!
  expect(finished.pendingRunId).toBeUndefined()
  expect(finished.messages).toHaveLength(4)
  expect(await chats.get('branch')).toEqual(branched)
})
