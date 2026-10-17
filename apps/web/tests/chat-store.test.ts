import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { EventType, type LLMRequest } from '@keundal/core'
import { IDBFactory } from 'fake-indexeddb'
import type { UIMessage } from 'ai'
import { expect, onTestFinished, test } from 'vitest'
import { ChatStore } from '../shared/utils/chat-store'
import { remoteLLMPlugin } from '../shared/utils/remote-llm'

const model = 'openai/gpt-5-nano'
const user: UIMessage = { id: 'user', role: 'user', parts: [
  { type: 'text', text: '원본 질문' },
  { type: 'file', filename: 'local.png', mediaType: 'image/png', url: 'data:image/png;base64,aW1hZ2U=' }
] }

test.each(['memory', 'indexeddb', 'sqlite'] as const)('%s 플러그인만 교체해도 웹 대화·이미지·투표·편집·재생성·삭제 계약이 같다', async (backend) => {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  const llm = ctx.plugin(remoteLLMPlugin, {
    fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      if (body.operation === 'model') return Response.json({ contextWindow: 128_000, maxOutputTokens: 4096 })
      if (body.operation === 'count') return Response.json({ tokens: 40 })
      const title = (body as LLMRequest).input.messages.some(message => message.role === 'system' && message.content.startsWith('Generate a chat title'))
      if (!title) requests.push(body)
      const text = title ? '로컬 제목' : JSON.stringify(body.input).includes('편집한 질문') ? '편집 응답' : '원본 응답'
      const messageId = crypto.randomUUID()
      const frames = [
        { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
        { type: EventType.TEXT_MESSAGE_END, messageId }, { done: true }
      ]
      const bytes = new TextEncoder().encode(frames.map(frame => `${JSON.stringify(frame)}\n`).join(''))
      // Split in the middle of UTF-8/JSON, as an actual network stream can.
      return new Response(new ReadableStream({ start(output) {
        for (let i = 0; i < bytes.length; i += 13) output.enqueue(bytes.slice(i, i + 13))
        output.close()
      } }))
    }
  })
  await llm
  const directory = await mkdtemp(join(tmpdir(), 'keundal-web-'))
  const store = backend === 'memory'
    ? ctx.plugin(memoryStorePlugin)
    : backend === 'sqlite'
      ? ctx.plugin(sqliteStorePlugin, { path: join(directory, 'chat.sqlite') })
      : ctx.plugin(indexedDBStorePlugin, { indexedDB: new IDBFactory(), databaseName: crypto.randomUUID(), locks: navigator.locks })
  await store
  const chats = new ChatStore(ctx)
  onTestFinished(async () => {
    await chats.stop()
    await store.dispose()
    await llm.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  await chats.create('chat', user, model)
  const response = await chats.respond('chat', { model, messages: [user] })
  expect(await response.text()).toContain('"type":"finish"')
  const reloaded = new ChatStore(ctx)
  let saved = (await reloaded.get('chat'))!
  expect(saved.title).toBe('로컬 제목')
  expect(saved.messages[0]).toEqual(user)
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', text: '원본 응답' })
  expect((await ctx.generation.list())[0]!.status).toBe('completed')
  await reloaded.rename('chat', '바꾼 제목')
  await reloaded.vote('chat', saved.messages[1]!.id, false)
  expect((await reloaded.list())[0]).toMatchObject({ title: '바꾼 제목', votes: [{ isUpvoted: false }] })
  await reloaded.truncate('chat', user.id, 'edit')
  const edited: UIMessage = { ...user, parts: [{ type: 'text', text: '편집한 질문' }] }
  expect(await (await reloaded.respond('chat', { model, messages: [edited] })).text()).toContain('"type":"finish"')
  saved = (await reloaded.get('chat'))!
  expect(saved.messages).toHaveLength(2)
  expect(saved.votes).toEqual([])
  expect(JSON.stringify(requests[1])).not.toContain('원본 응답')
  expect(JSON.stringify((await ctx.session.get('chat'))!.messages)).not.toContain('원본 질문')
  await reloaded.truncate('chat', saved.messages[1]!.id, 'regenerate')
  expect((await reloaded.get('chat'))!.messages).toEqual([edited])
  expect(await (await reloaded.respond('chat', { model, messages: [edited] })).text()).toContain('"type":"finish"')
  await reloaded.delete('chat')
  expect(await reloaded.get('chat')).toBeUndefined()
  expect(await reloaded.list()).toEqual([])
  expect(await ctx.generation.list()).toEqual([])
})

test('HTTP 연결이 완료 표시 전에 끝나면 성공으로 커밋하지 않고 부분 응답을 보존한다', async () => {
  const ctx = new Context()
  const llm = ctx.plugin(remoteLLMPlugin, { fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string)
    if (body.operation === 'model') return Response.json({ contextWindow: 128_000, maxOutputTokens: 4096 })
    if (body.operation === 'count') return Response.json({ tokens: 40 })
    return new Response([
      { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'partial', delta: '끊긴 응답' }
    ].map(frame => `${JSON.stringify(frame)}\n`).join(''))
  } })
  await llm
  const store = ctx.plugin(memoryStorePlugin)
  await store
  onTestFinished(async () => {
    await store.dispose()
    await llm.dispose()
  })
  const chats = new ChatStore(ctx)
  await chats.create('chat', user, model)
  await chats.rename('chat', '제목 생성 생략')
  const stream = await (await chats.respond('chat', { model, messages: [user] })).text()
  expect(stream).toContain('Incomplete LLM stream')
  expect(stream).not.toContain('"type":"finish"')
  expect((await ctx.generation.list())[0]!.status).toBe('failed')
  expect((await chats.get('chat'))!.messages[1]!.parts).toContainEqual({ type: 'text', text: '끊긴 응답' })
})

test('IndexedDB를 다시 열면 미완료 journal을 한 번 복구하고 LLM을 재호출하지 않는다', async () => {
  const indexedDB = new IDBFactory()
  const databaseName = crypto.randomUUID()
  let networkRequests = 0
  const config = { fetch: async () => {
    networkRequests++
    throw new Error('Recovery must not call the network')
  } }
  const ctx = new Context()
  const initialLLM = ctx.plugin(remoteLLMPlugin, config)
  await initialLLM
  const store = ctx.plugin(indexedDBStorePlugin, { indexedDB, databaseName, locks: navigator.locks })
  await store
  const chats = new ChatStore(ctx)
  await chats.create('chat', user, model)
  const snapshot = (await ctx.session.get('chat'))!
  const chat = { ...(await chats.get('chat'))!, started: true, pendingRunId: 'interrupted' }
  const saved = await ctx.session.commit({ ...snapshot, expectedRevision: snapshot.revision, state: { web: chat } })
  const iterator = ctx.generation.run({
    model: 'gpt-5-nano', maxOutputTokens: 4096, sessionRevision: saved.revision,
    input: { threadId: 'chat', runId: 'interrupted', messages: saved.messages, state: saved.state, tools: [], context: [] }
  }, { stream: async function* () {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' }
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'partial', delta: '저장된 부분 응답' }
  } })[Symbol.asyncIterator]()
  await iterator.next() // RUN_STARTED
  await iterator.next() // TEXT_MESSAGE_START
  await iterator.next() // TEXT_MESSAGE_CONTENT
  await store.dispose()
  await iterator.return?.()
  await initialLLM.dispose()

  const reopened = new Context()
  const llm = reopened.plugin(remoteLLMPlugin, config)
  await llm
  const reopenedStore = reopened.plugin(indexedDBStorePlugin, { indexedDB, databaseName, locks: navigator.locks })
  await reopenedStore
  onTestFinished(async () => {
    await reopenedStore.dispose()
    await llm.dispose()
  })
  const recovered = new ChatStore(reopened)
  await recovered.recover()
  await recovered.recover()
  expect(networkRequests).toBe(0)
  expect((await reopened.generation.get('interrupted'))!.status).toBe('interrupted')
  const result = (await recovered.get('chat'))!
  expect(result.started).toBe(true)
  expect(result.pendingRunId).toBeUndefined()
  expect(result.messages).toHaveLength(2)
  expect(result.messages[1]!.id).toBe('interrupted')
  expect(result.messages[1]!.parts).toContainEqual({ type: 'text', text: '저장된 부분 응답' })
})
