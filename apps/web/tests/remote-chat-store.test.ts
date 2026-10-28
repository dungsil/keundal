import { createServer } from 'node:http'

import { EventType, type AGUIEvent, type ExecutionOptions } from '@keundal/core'
import { LLMService, type LLMRequest, type LLMEvent } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { createAgentApp, type AgentAppServices } from '@keundal/agent-host/http'
import { Context } from 'cordis'
import { createApp, toNodeListener } from 'h3'
import { onTestFinished, test, expect } from 'vitest'

import { createAgentHandler } from '../server/agent/handler'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { RemoteChatStore } from '@keundal/chat-http'
import { createDesktopChatStore } from '@keundal/plugin-chat-desktop'
import { readTraceSpans } from '@keundal/trace'

const token = 'remote-test-token'
const model = 'openai/gpt-5-nano'
const user: ChatMessage = { id: 'user', role: 'user', parts: [{ type: 'text', text: '원격 질문' }] }

async function collect(events: AsyncIterable<AGUIEvent>) {
  const result: AGUIEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

test.each([false, true])('원격 저장소는 HTTP 호스트에서 대화·제목·투표·편집·분기·삭제를 수행한다 (desktop=%s)', async (desktop) => {
  const ctx = new Context()
  const inputs: LLMRequest['input'][] = []
  const titleModels: string[] = []
  const selections: unknown[] = []
  const requestedModels: string[] = []
  let unavailable = false
  class ScriptedLLM extends LLMService {
    async getModel() { return { contextWindow: 128_000, maxOutputTokens: 4096, capabilities: { tools: true } } }
    async countTokens() { return 40 }
    async* stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      requestedModels.push(request.model)
      if (unavailable && request.model !== 'title') throw Object.assign(new Error('Unavailable'), { status: 503 })
      inputs.push(request.input)
      const text = JSON.stringify(request.input).includes('편집한 질문') ? '편집 응답' : '원격 응답'
      const messageId = crypto.randomUUID()
      yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text }
      yield { type: EventType.TEXT_MESSAGE_END, messageId }
    }
  }
  const llm = await ctx.plugin(ScriptedLLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 100, subagents: true })
  const services: AgentAppServices = {
    run: (input, options?: ExecutionOptions) => ctx.agent.run(input, options),
    steer: () => 0,
    cancel: () => false,
    subscribe: (runId, options) => ctx.generation.subscribe(runId, options),
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
    models: () => [
      { id: 'gpt-5-nano', provider: 'openai', contextWindow: 128_000, maxOutputTokens: 4096 },
      { id: 'title', provider: 'anthropic', contextWindow: 128_000, maxOutputTokens: 4096 }
    ],
    title: async (request) => {
      titleModels.push(request.model)
      return '원격 제목'
    }
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
    ? await createDesktopChatStore(async <T>(_command: string, args: unknown) => {
        selections.push(args)
        return { endpoint, token } as T
      }, () => [], model)
    : new RemoteChatStore({ endpoint, token })
  await chats.create('chat', user, model)
  const roles = [{ name: 'reviewer', description: 'Review changes', instructions: 'Check correctness.' }]
  const promptPreset = {
    id: 'review', name: 'Review', variables: { focus: 'risks' }, blocks: [
      { id: 'history', type: 'history' as const, name: 'History', enabled: true },
      { id: 'focus', type: 'text' as const, name: 'Focus', enabled: true, role: 'user' as const, content: 'Preset focus: {{focus}}' }
    ]
  }
  const events = await collect(chats.respond('chat', { model, titleModel: 'anthropic/title', messages: [user], systemPrompt: 'First system prompt.', promptPreset, subagentRoles: roles }))
  expect(events.some(event => event.type === EventType.RUN_FINISHED)).toBe(true)
  expect(inputs[0]!.tools.find(tool => tool.name === 'delegate_task')?.parameters).toMatchObject({ properties: { role: { enum: ['reviewer'] } } })
  const firstInput = JSON.stringify(inputs[0])
  expect(firstInput).toContain('First system prompt.')
  expect(firstInput).toContain('You are a knowledgeable and helpful AI assistant.')
  expect(inputs[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'Preset focus: risks' })
  await collect(chats.respond('chat', { model, messages: [user], systemPrompt: 'Changed system prompt.', subagentRoles: [] }))
  expect(inputs[1]!.tools.find(tool => tool.name === 'delegate_task')?.parameters.properties).not.toHaveProperty('role')
  const changedInput = JSON.stringify(inputs[1])
  expect(changedInput).toContain('Changed system prompt.')
  expect(changedInput).not.toContain('First system prompt.')
  expect(inputs[1]!.messages.some(message => message.id.startsWith('keundal:prompt:'))).toBe(false)
  expect(changedInput).toContain('keundal:web-instructions')
  expect(changedInput.match(/keundal:web-instructions/g)).toHaveLength(1)
  await collect(chats.respond('chat', { model, messages: [user], systemPrompt: ' \n ' }))
  const clearedInput = JSON.stringify(inputs[2])
  expect(clearedInput).not.toContain('Changed system prompt.')
  expect(clearedInput).toContain('You are a knowledgeable and helpful AI assistant.')
  expect(clearedInput).toContain('keundal:web-instructions')
  expect(clearedInput.match(/keundal:web-instructions/g)).toHaveLength(1)

  const saved = (await chats.get('chat'))!
  expect(titleModels).toEqual(['title'])
  if (desktop) expect(selections).toMatchObject([
    { selection: { provider: 'openai', model: 'gpt-5-nano' } },
    { selection: { provider: 'anthropic', model: 'title' } },
    { selection: { provider: 'openai', model: 'gpt-5-nano' } }
  ])
  expect(saved.title).toBe('원격 제목')
  expect(saved.messages).toHaveLength(2)
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', text: '원격 응답' })
  expect((await chats.list())[0]!.id).toBe('chat')
  expect(await chats.listSummaries!()).toEqual([{ id: saved.id, title: saved.title, createdAt: saved.createdAt }])

  services.title = async () => 'x'.repeat(101)
  await chats.create('oversized-title', user, model)
  const oversized = await collect(chats.respond('oversized-title', { model, messages: [user] }))
  expect(oversized.at(-1)!.type).toBe(EventType.RUN_FINISHED)
  expect((await chats.get('oversized-title'))!.title).toBeNull()
  await chats.delete('oversized-title')

  await chats.rename('chat', '바꾼 제목')
  await chats.vote('chat', saved.messages[1]!.id, false)
  expect((await chats.get('chat'))!.votes).toEqual([{ chatId: 'chat', messageId: saved.messages[1]!.id, isUpvoted: false }])

  await chats.truncate('chat', user.id, 'edit')
  const edited: ChatMessage = { ...user, parts: [{ type: 'text', text: '편집한 질문' }] }
  await collect(chats.respond('chat', { model, messages: [edited] }))
  expect((await chats.get('chat'))!.messages).toHaveLength(2)
  expect((await chats.get('chat'))!.messages[1]!.parts).toContainEqual({ type: 'text', text: '편집 응답' })

  const original = (await chats.get('chat'))!
  const runId = original.messages[1]!.id
  await chats.vote('chat', runId, true)
  const branched = await chats.branch('chat', runId, 'branch')
  expect(branched.messages).toEqual(original.messages)
  expect(branched.votes).toEqual([{ chatId: 'branch', messageId: runId, isUpvoted: true }])
  expect(branched.started).toBe(true)
  expect(await chats.get('branch')).toEqual(branched)
  expect((await chats.get('chat'))!.votes).toEqual([{ chatId: 'chat', messageId: runId, isUpvoted: true }])
  await expect(chats.branch('chat', runId, 'branch')).rejects.toThrow('Chat already exists')
  await expect(chats.branch('chat', 'missing', 'other')).rejects.toThrow('Invalid message')
  expect(await chats.get('other')).toBeUndefined()
  expect(await chats.getRun(runId)).toMatchObject({ status: 'completed' })
  await chats.delete('chat')
  expect(await chats.get('branch')).toEqual(branched)
  expect(await chats.getRun(runId)).toBeUndefined()
  await chats.delete('branch')
  await chats.create('chat', user, model)

  unavailable = true
  requestedModels.length = 0
  const recovered = await collect(chats.respond('chat', {
    model, messages: [user], modelRecovery: { retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 }, fallbackModels: ['anthropic/title'] }
  }))
  expect(recovered.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(requestedModels).toEqual(['test', 'test', 'title'])
  expect(readTraceSpans(recovered).filter(span => span.kind === 'model').map(span => [span.model, span.status]))
    .toEqual([['test', 'failed'], ['test', 'failed'], ['title', 'completed']])
  requestedModels.length = 0
  const failed = await collect(chats.respond('chat', { model, messages: [user], modelRecovery: { retry: false, fallbackModels: [] } }))
  expect(failed.at(-1)?.type).toBe(EventType.RUN_ERROR)
  expect(requestedModels).toEqual(['test'])

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


test('원격 요약 요청은 상태 필드를 제한하고 캐시를 사용하지 않는다', async () => {
  const requests: { url: string; cache: RequestCache | undefined }[] = []
  const store = new RemoteChatStore({ endpoint: 'https://example.test', token }, async (url, init) => {
    requests.push({ url: String(url), cache: init?.cache })
    return new Response(JSON.stringify([
      { state: { web: { id: 'b', title: null, createdAt: '2026-10-23', messages: ['must not escape'] } } },
      { state: { web: { id: 'a', title: 'first', createdAt: '2026-10-23' } } },
      { state: { unrelated: true } }
    ]), { headers: { 'content-type': 'application/json' } })
  })
  expect(await store.listSummaries()).toEqual([
    { id: 'a', title: 'first', createdAt: '2026-10-23' },
    { id: 'b', title: null, createdAt: '2026-10-23' }
  ])
  expect(requests).toEqual([{ url: 'https://example.test/threads?view=summary&stateFields=web.id,web.title,web.createdAt', cache: 'no-store' }])
})
