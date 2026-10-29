import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

import { createAgentHost } from '@keundal/agent-host'
import { createAgentApp } from '@keundal/agent-host/http'
import { RemoteChatStore } from '@keundal/chat-http'
import { EventType } from '@keundal/core'
import { LLMService, type LLMEvent } from '@keundal/llm'
import acpAgentPlugin from '@keundal/plugin-agent-acp'
import { ChatStore, type MountAgent } from '@keundal/plugin-chat-local'
import memoryStore from '@keundal/plugin-store-memory'
import { expect, onTestFinished, test } from 'vitest'

const user = (id: string, text: string) => ({
  id,
  role: 'user' as const,
  parts: [{ type: 'text' as const, text }]
})
const model = 'openai/test'

async function setup(execution: 'local' | 'http') {
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 8000, maxOutputTokens: 4096 }
    }
    async countTokens() {
      return 1
    }
    async *stream(): AsyncGenerator<LLMEvent> {
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'title', role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'title', delta: 'Chat title' }
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'title' }
    }
  }
  const mountAgent: MountAgent = async (ctx) =>
    ctx.plugin(acpAgentPlugin, {
      command: process.execPath,
      args: [fileURLToPath(new URL('./stdio.ts', import.meta.url))],
      cwd: process.cwd()
    })
  const host = await createAgentHost({
    model: 'test',
    models: [{ id: 'test', provider: 'openai', contextWindow: 8000, maxOutputTokens: 4096 }],
    setup: async (ctx) => {
      await ctx.plugin(LLM)
      await ctx.plugin(memoryStore)
    },
    mountAgent
  })
  const server = createServer(createAgentApp(host.services, { token: 'test-token' }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const store =
    execution === 'local'
      ? new ChatStore(host.ctx, mountAgent)
      : new RemoteChatStore({ endpoint: `http://127.0.0.1:${address.port}`, token: 'test-token' })
  onTestFinished(async () => {
    await store.stop()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await host.dispose()
  })
  return { store, host }
}

test.each(['local', 'http'] as const)(
  '%s 일반 채팅은 ACP의 첫 응답과 후속 응답을 저장하고 후속 턴에 새 사용자 메시지만 보낸다',
  async (execution) => {
    const { store, host } = await setup(execution)
    await store.create('chat', user('first', 'first'), model)
    for (const [index, prompt] of ['first', 'second'].entries()) {
      const previous = (await store.get('chat'))!
      const messages = index ? [...previous.messages, user('second', prompt)] : previous.messages
      const events = await Array.fromAsync(store.respond('chat', { model, messages, systemPrompt: '  ' }))
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
      expect(
        events.flatMap((event) => (event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [])).join('')
      ).toBe(`${index + 1}:${prompt}:${process.cwd()}!`)
      const saved = (await store.get('chat'))!
      expect(saved.pendingRunId).toBeUndefined()
      expect(saved.messages).toHaveLength((index + 1) * 2)
      expect(saved.title).toBe('Chat title')
      const reply = saved.messages.at(-1)!
      expect(reply.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')).toBe(
        `${index + 1}:${prompt}:${process.cwd()}!`
      )
      const run = await host.services.generation.get(reply.id)
      expect(run?.status).toBe('completed')
      expect(run?.journal.at(-1)?.event.type).toBe(EventType.RUN_FINISHED)
      expect(run?.request.input.messages.some((message) => message.role === 'system')).toBe(false)
    }
    expect(
      (await host.services.session.get('chat'))?.messages.filter((message) => message.role === 'user')
    ).toHaveLength(2)
  }
)

test.each(['local', 'http'] as const)(
  '%s 일반 채팅은 ACP에 전달할 수 없는 사용자 지침을 오류로 알리고 외부 실행을 시작하지 않는다',
  async (execution) => {
    const { store, host } = await setup(execution)
    for (const [index, options] of [
      { systemPrompt: 'Always answer in Korean' },
      {
        promptPreset: {
          id: 'preset',
          name: 'Preset',
          blocks: [{ id: 'history', name: 'History', type: 'history' as const, enabled: true }],
          variables: {}
        }
      },
      { memoryProjectId: 'project' },
      { modelRecovery: { fallbackModels: [] } }
    ].entries()) {
      const id = `unsupported-${index}`
      const message = user(id, 'hello')
      await store.create(id, message, model)
      const events = await Array.fromAsync(store.respond(id, { model, messages: [message], ...options }))
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        message: expect.stringMatching(/not support|not supported/)
      })
      expect(events.some((event) => event.type === EventType.RUN_STARTED)).toBe(false)
      expect((await store.get(id))?.pendingRunId).toBeUndefined()
    }
    expect(await host.services.generation.list()).toEqual([])
  }
)
