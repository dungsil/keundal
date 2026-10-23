import { mountAgent } from './fixtures/agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { EventType, LLMService, type AGUIEvent, type LLMRequest, type LLMEvent } from '@keundal/core'
import { IDBFactory } from 'fake-indexeddb'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { expect, onTestFinished, test } from 'vitest'
import { ChatStore } from '@keundal/plugin-chat-local'
import { browserLLMPlugin } from '@keundal/plugin-llm-browser'
import { defaultLLMSettings } from '@keundal/llm-settings'
import { useKeundalChat } from '../../ui-chat/app/lib/use-keundal-chat'

const model = 'openai/gpt-5-nano'
const user: ChatMessage = { id: 'user', role: 'user', parts: [
  { type: 'text', text: '원본 질문' },
  { type: 'file', filename: 'local.png', mediaType: 'image/png', url: 'data:image/png;base64,aW1hZ2U=' }
] }

async function collect(events: AsyncIterable<AGUIEvent>) {
  const result: AGUIEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

test.each(['memory', 'indexeddb', 'sqlite'] as const)('%s 플러그인만 교체해도 웹 대화·이미지·투표·편집·재생성·삭제 계약이 같다', async (backend) => {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class ScriptedLLM extends LLMService {
    async getModel() { return { contextWindow: 128_000, maxOutputTokens: 4096 } }
    async countTokens() { return 40 }
    async* stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      const title = request.input.messages.some(message => message.role === 'system' && message.content.startsWith('Generate a chat title'))
      if (!title) requests.push(request)
      const text = title ? '로컬 제목' : JSON.stringify(request.input).includes('편집한 질문') ? '편집 응답' : '원본 응답'
      const messageId = crypto.randomUUID()
      yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' as const }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text }
      yield { type: EventType.TEXT_MESSAGE_END, messageId }
    }
  }
  const llm = ctx.plugin(ScriptedLLM)
  await llm
  const directory = await mkdtemp(join(tmpdir(), 'keundal-web-'))
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
  await chats.create('chat', user, model)
  for await (const event of chats.respond('chat', { model, messages: [user] })) {
    if (event.type === EventType.RUN_FINISHED) {
      expect((await chats.get('chat'))!.messages[1]!.parts).toContainEqual({ type: 'text', text: '원본 응답' })
      expect((await chats.get('chat'))!.pendingRunId).toBeUndefined()
    }
  }
  const reloaded = new ChatStore(ctx, mountAgent)
  let saved = (await reloaded.get('chat'))!
  expect(saved.title).toBe('로컬 제목')
  expect(saved.messages[0]).toEqual(user)
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', text: '원본 응답' })
  expect((await ctx.generation.list())[0]!.status).toBe('completed')
  await reloaded.rename('chat', '바꾼 제목')
  await reloaded.vote('chat', saved.messages[1]!.id, false)
  expect((await reloaded.list())[0]).toMatchObject({ title: '바꾼 제목', votes: [{ isUpvoted: false }] })
  const client = useKeundalChat({ respond: (messages, onMessage, signal) => reloaded.respond('chat', { model, messages, onMessage }, signal) })
  client.messages.value = saved.messages
  await reloaded.truncate('chat', user.id, 'edit')
  const edited: ChatMessage = { ...user, parts: [{ type: 'text', text: '편집한 질문' }] }
  const editing = client.sendMessage({ text: '편집한 질문', messageId: user.id })
  expect(client.status.value).toBe('submitted')
  await editing
  expect(client.status.value).toBe('ready')
  expect(client.error.value).toBeUndefined()
  saved = (await reloaded.get('chat'))!
  expect(client.messages.value).toEqual(saved.messages)
  expect(saved.messages).toHaveLength(2)
  expect(saved.votes).toEqual([])
  expect(JSON.stringify(requests[1])).not.toContain('원본 응답')
  expect(JSON.stringify((await ctx.session.get('chat'))!.messages)).not.toContain('원본 질문')
  await reloaded.truncate('chat', saved.messages[1]!.id, 'regenerate')
  expect((await reloaded.get('chat'))!.messages).toEqual([edited])
  await client.regenerate({ messageId: saved.messages[1]!.id })
  expect(client.status.value).toBe('ready')
  expect(client.messages.value).toEqual((await reloaded.get('chat'))!.messages)
  expect(client.messages.value).toHaveLength(2)
  await reloaded.delete('chat')
  expect(await reloaded.get('chat')).toBeUndefined()
  expect(await reloaded.list()).toEqual([])
  expect(await ctx.generation.list()).toEqual([])
})

test('LLM 오류가 발생하면 성공으로 커밋하지 않고 부분 응답을 보존한다', async () => {
  const ctx = new Context()
  class FailingLLM extends LLMService {
    async getModel() { return { contextWindow: 128_000, maxOutputTokens: 4096 } }
    async countTokens() { return 40 }
    async* stream(): AsyncIterable<LLMEvent> {
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' as const }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'partial', delta: '끊긴 응답' }
      throw new Error('Provider failed')
    }
  }
  const llm = ctx.plugin(FailingLLM)
  await llm
  const store = ctx.plugin(memoryStorePlugin)
  await store
  onTestFinished(async () => {
    await store.dispose()
    await llm.dispose()
  })
  const chats = new ChatStore(ctx, mountAgent)
  await chats.create('chat', user, model)
  await chats.rename('chat', '제목 생성 생략')
  const stream = await collect(chats.respond('chat', { model, messages: [user] }))
  expect(stream).toContainEqual(expect.objectContaining({ type: EventType.RUN_ERROR, message: 'Provider failed' }))
  expect(stream.some(event => event.type === EventType.RUN_FINISHED)).toBe(false)
  expect((await ctx.generation.list())[0]!.status).toBe('failed')
  expect((await chats.get('chat'))!.messages[1]!.parts).toContainEqual({ type: 'text', text: '끊긴 응답' })
  const client = useKeundalChat({ respond: (messages, onMessage, signal) => chats.respond('chat', { model, messages, onMessage }, signal) })
  client.messages.value = (await chats.get('chat'))!.messages
  await client.regenerate()
  expect(client.status.value).toBe('error')
  expect(client.error.value?.message).toBe('Provider failed')
  expect(client.messages.value).toEqual((await chats.get('chat'))!.messages)
  expect(client.messages.value.at(-1)!.parts).toContainEqual({ type: 'text', text: '끊긴 응답' })
})

test('Vue 채팅 중단은 공급자 작업을 취소하고 부분 응답 저장 후 ready로 돌아와 다음 전송을 허용한다', async () => {
  const ctx = new Context()
  let started!: () => void
  const streaming = new Promise<void>(resolve => started = resolve)
  let cancelled = false
  class CancellableLLM extends LLMService {
    async getModel() { return { contextWindow: 128_000, maxOutputTokens: 4096 } }
    async countTokens() { return 40 }
    async* stream(_request: LLMRequest, options?: { signal?: AbortSignal }): AsyncIterable<LLMEvent> {
      const messageId = crypto.randomUUID()
      yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: cancelled ? '다음 응답' : '중단 전 응답' }
      if (!cancelled) {
        started()
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            cancelled = true
            reject(options!.signal!.reason)
          }
          if (options?.signal?.aborted) abort()
          else options?.signal?.addEventListener('abort', abort, { once: true })
        })
      }
      yield { type: EventType.TEXT_MESSAGE_END, messageId }
    }
  }
  const llm = await ctx.plugin(CancellableLLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const chats = new ChatStore(ctx, mountAgent)
  const client = useKeundalChat({ respond: (messages, onMessage, signal) => chats.respond('chat', { model, messages, onMessage }, signal) })
  onTestFinished(async () => {
    await client.stop()
    await store.dispose()
    await llm.dispose()
  })
  await chats.create('chat', user, model)
  await chats.rename('chat', '중단 테스트')
  client.messages.value = [user]
  const running = client.regenerate()
  await streaming
  expect(client.status.value).toBe('streaming')
  expect(client.messages.value.at(-1)!.parts).toContainEqual({ type: 'text', text: '중단 전 응답', state: 'streaming' })
  await client.stop()
  await running
  expect(cancelled).toBe(true)
  expect(client.status.value).toBe('ready')
  expect(client.error.value).toBeUndefined()
  expect(client.messages.value).toEqual((await chats.get('chat'))!.messages)
  expect(client.messages.value.at(-1)!.parts).toContainEqual({ type: 'text', text: '중단 전 응답' })
  expect((await ctx.generation.list())[0]!.status).toBe('cancelled')
  await client.sendMessage({ text: '계속' })
  expect(client.status.value).toBe('ready')
  expect(client.messages.value).toHaveLength(4)
  expect(client.messages.value.at(-1)!.parts).toContainEqual({ type: 'text', text: '다음 응답' })
})

test('IndexedDB를 다시 열면 미완료 journal을 한 번 복구하고 LLM을 재호출하지 않는다', async () => {
  const indexedDB = new IDBFactory()
  const databaseName = crypto.randomUUID()
  let networkRequests = 0
  const config = { getSettings: () => {
    networkRequests++
    return defaultLLMSettings()
  } }
  const ctx = new Context()
  const initialLLM = ctx.plugin(browserLLMPlugin, config)
  await initialLLM
  const store = ctx.plugin(indexedDBStorePlugin, { indexedDB, databaseName, locks: navigator.locks })
  await store
  const chats = new ChatStore(ctx, mountAgent)
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
  const llm = reopened.plugin(browserLLMPlugin, config)
  await llm
  const reopenedStore = reopened.plugin(indexedDBStorePlugin, { indexedDB, databaseName, locks: navigator.locks })
  await reopenedStore
  onTestFinished(async () => {
    await reopenedStore.dispose()
    await llm.dispose()
  })
  const recovered = new ChatStore(reopened, mountAgent)
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

test('웹 대화가 다음 턴에서도 준비한 축약을 재사용하고 최신 화면 상태와 메시지를 보존한다', async () => {
  const ctx = new Context()
  const gate = Promise.withResolvers<undefined>()
  const ready = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<AbortSignal>()
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel() { return { contextWindow: 10000, maxOutputTokens: 1000 } }
    async countTokens(request: LLMRequest) {
      if (request.input.messages.some(message => 'content' in message && typeof message.content === 'string' && message.content.startsWith('Summary of earlier'))) ready.resolve(undefined)
      return request.input.messages.some(message => message.id === 'history-0') ? 8000 : 100
    }

    async* stream(request: LLMRequest, execution?: { signal?: AbortSignal }): AsyncIterable<LLMEvent> {
      const summary = request.input.messages.some(message => message.role === 'system' && message.content.startsWith('Summarize the conversation data'))
      const title = request.input.messages.some(message => message.role === 'system' && message.content.startsWith('Generate a chat title'))
      if (summary) {
        started.resolve(execution!.signal!)
        await gate.promise
      } else if (!title) requests.push(request)
      const messageId = crypto.randomUUID()
      yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: summary ? 'Earlier facts.' : 'Response' }
      yield { type: EventType.TEXT_MESSAGE_END, messageId }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const chats = new ChatStore(ctx, mountAgent)
  onTestFinished(async () => {
    gate.resolve(undefined)
    await chats.stop()
    await store.dispose()
    await llm.dispose()
  })
  const messages: ChatMessage[] = Array.from({ length: 9 }, (_, index) => ({
    id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `Message ${index}` }]
  }))
  await chats.create('proactive', messages[0]!, model)
  expect((await collect(chats.respond('proactive', { model, messages }))).at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect((await started.promise).aborted).toBe(false)
  gate.resolve(undefined)
  await ready.promise
  await new Promise(resolve => setTimeout(resolve, 0))
  const saved = (await chats.get('proactive'))!
  const next: ChatMessage = { id: 'new-question', role: 'user', parts: [{ type: 'text', text: 'Next question' }] }
  expect((await collect(chats.respond('proactive', { model, messages: [...saved.messages, next] }))).at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(requests).toHaveLength(2)
  expect(requests[1]!.input.messages.some(message => message.id === 'history-0')).toBe(false)
  expect(requests[1]!.input.messages.some(message => message.id === next.id)).toBe(true)
  expect((requests[1]!.input.state as { web: { messages: ChatMessage[] } }).web.messages.at(-1)).toEqual(next)
})

test.each([undefined, 'anthropic/title', 'anthropic/failing'])('제목 모델 %s을 사용해도 채팅 모델과 응답은 유지한다', async (titleModel) => {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class ScriptedLLM extends LLMService {
    async getModel(name: string) { return { contextWindow: 128_000, maxOutputTokens: name === 'anthropic/title' ? 512 : 4096 } }
    async countTokens() { return 40 }
    async* stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push(request)
      if (request.model === 'anthropic/failing') throw new Error('Title unavailable')
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: '응답' }
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
    }
  }
  const llm = await ctx.plugin(ScriptedLLM)
  const storage = await ctx.plugin(memoryStorePlugin)
  const chats = new ChatStore(ctx, mountAgent)
  onTestFinished(async () => {
    await chats.stop()
    await storage.dispose()
    await llm.dispose()
  })
  await chats.create('separate-models', user, model)
  const events = await collect(chats.respond('separate-models', { model, titleModel, messages: [user] }))
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(requests.map(request => request.model)).toEqual([titleModel ?? model, model])
  if (titleModel === 'anthropic/title') expect(requests[0]!.maxOutputTokens).toBe(512)
  expect((await chats.get('separate-models'))!.model).toBe(model)
})
