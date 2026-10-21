import { createServer } from 'node:http'

import {
  EventType,
  LLMService,
  type AGUIEvent,
  type ExecutionOptions,
  type LLMRequest,
  type LLMEvent
} from '@keundal/core'
import agentPlugin from '@keundal/agent'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { createAgentApp, type AgentAppServices } from '@keundal/agent-host/http'
import { Context } from 'cordis'
import { createApp, toNodeListener } from 'h3'
import { onTestFinished, test, expect } from 'vitest'

import { createAgentHandler } from '../server/agent/handler'
import type { ChatMessage } from '@keundal/chat-app/shared/utils/chat-message'
import { RemoteChatStore } from '@keundal/chat-app/shared/utils/remote-chat-store'
import { createDesktopChatStore } from '@keundal/chat-app/shared/utils/desktop-chat-store'

const token = 'remote-test-token'
const model = 'openai/gpt-5-nano'
const user: ChatMessage = { id: 'user', role: 'user', parts: [{ type: 'text', text: '원격 질문' }] }

async function collect(events: AsyncIterable<AGUIEvent>) {
  const result: AGUIEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

test.each([false, true])('원격 저장소는 HTTP 호스트에서 대화·제목·투표·편집·삭제를 수행한다 (desktop=%s)', async (desktop) => {
  const ctx = new Context()
  class ScriptedLLM extends LLMService {
    async getModel() { return { contextWindow: 128_000, maxOutputTokens: 4096 } }
    async countTokens() { return 40 }
    async* stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      const text = JSON.stringify(request.input).includes('편집한 질문') ? '편집 응답' : '원격 응답'
      const messageId = crypto.randomUUID()
      yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text }
      yield { type: EventType.TEXT_MESSAGE_END, messageId }
    }
  }
  const llm = await ctx.plugin(ScriptedLLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 100 })
  const services: AgentAppServices = {
    run: (input, options?: ExecutionOptions) => ctx.agent.run(input, options),
    session: {
      get: (threadId, options) => ctx.session.get(threadId, options),
      list: options => ctx.session.list(options),
      commit: (change, options) => ctx.session.commit(change, options),
      delete: (threadId, revision, options) => ctx.session.delete(threadId, revision, options)
    },
    generation: {
      get: (runId, options) => ctx.generation.get(runId, options),
      list: options => ctx.generation.list(options),
      recover: options => ctx.generation.recover(options)
    },
    models: () => [{ id: 'gpt-5-nano', provider: 'openai', contextWindow: 128_000, maxOutputTokens: 4096 }],
    title: async () => '원격 제목'
  }
  const app = createApp()
  app.use('/api/agent', createAgentHandler(async () => createAgentApp(services, { token })))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })

  const endpoint = `http://127.0.0.1:${address.port}/api/agent`
  expect((await fetch(`${endpoint}/models`)).status).toBe(401)
  const chats = desktop
    ? await createDesktopChatStore(async <T>() => ({ endpoint, token }) as T, () => [], model)
    : new RemoteChatStore({ endpoint, token })
  await chats.create('chat', user, model)
  const events = await collect(chats.respond('chat', { model, messages: [user] }))
  expect(events.some(event => event.type === EventType.RUN_FINISHED)).toBe(true)

  const saved = (await chats.get('chat'))!
  expect(saved.title).toBe('원격 제목')
  expect(saved.messages).toHaveLength(2)
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', text: '원격 응답' })
  expect((await chats.list())[0]!.id).toBe('chat')

  await chats.rename('chat', '바꾼 제목')
  await chats.vote('chat', saved.messages[1]!.id, false)
  expect((await chats.get('chat'))!.votes).toEqual([{ chatId: 'chat', messageId: saved.messages[1]!.id, isUpvoted: false }])

  await chats.truncate('chat', user.id, 'edit')
  const edited: ChatMessage = { ...user, parts: [{ type: 'text', text: '편집한 질문' }] }
  await collect(chats.respond('chat', { model, messages: [edited] }))
  expect((await chats.get('chat'))!.messages).toHaveLength(2)
  expect((await chats.get('chat'))!.messages[1]!.parts).toContainEqual({ type: 'text', text: '편집 응답' })

  await chats.delete('chat')
  expect(await chats.get('chat')).toBeUndefined()
  expect(await chats.list()).toEqual([])
})

test('웹 API는 호스트 준비 실패를 503으로 알리고 내부 오류를 노출하지 않는다', async () => {
  const app = createApp()
  app.use('/api/agent', createAgentHandler(async () => {
    throw new Error('private host configuration')
  }))
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/models`)
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('private host configuration')
})
