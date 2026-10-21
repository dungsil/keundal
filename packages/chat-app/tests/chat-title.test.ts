import { Context } from 'cordis'
import { EventType, LLMService, type LLMEvent } from '@keundal/core'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { expect, onTestFinished, test } from 'vitest'
import { createKeundalChat } from '../shared/utils/keundal'
import { ChatStore } from '../shared/utils/chat-store'
import { validateChatTitle } from '../shared/utils/chat-title'

const model = 'openai/test'
const user = { id: 'user', role: 'user', parts: [{ type: 'text', text: '질문' }] } as const

for (const chunks of [['x'.repeat(101)], ['x'.repeat(60), 'x'.repeat(41)], [' '.repeat(1025)], ['x'.repeat(100_000)]]) {
  test(`생성 제목이 한도를 넘으면 저장하지 않고 응답은 계속한다 (${chunks.map(chunk => chunk.length).join('+')})`, async () => {
    const ctx = new Context()
    let closed = false
    class LLM extends LLMService {
      async getModel() { return { contextWindow: 8000, maxOutputTokens: 4096 } }
      async countTokens() { return 10 }
      async* stream(request: Parameters<LLMService['stream']>[0]): AsyncIterable<LLMEvent> {
        const isTitle = request.input.messages.some(message => message.role === 'system' && message.content.startsWith('Generate a chat title'))
        try {
          yield { type: EventType.TEXT_MESSAGE_START, messageId: 'message', role: 'assistant' as const }
          for (const delta of isTitle ? chunks : ['정상 응답']) yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message', delta }
          yield { type: EventType.TEXT_MESSAGE_END, messageId: 'message' }
        } finally {
          if (isTitle) closed = true
        }
      }
    }
    const llm = await ctx.plugin(LLM)
    const store = await ctx.plugin(memoryStorePlugin)
    const chats = new ChatStore(ctx)
    onTestFinished(async () => {
      await chats.stop()
      await store.dispose()
      await llm.dispose()
    })
    const message = { ...user, parts: [...user.parts] }
    await chats.create('chat', message, model)
    const events = []
    for await (const event of chats.respond('chat', { model, messages: [message] })) events.push(event)
    expect(closed).toBe(true)
    expect((await chats.get('chat'))!.title).toBeNull()
    expect(events.at(-1)!.type).toBe(EventType.RUN_FINISHED)
    expect((await chats.get('chat'))!.messages.at(-1)!.parts).toContainEqual({ type: 'text', text: '정상 응답' })
  })
}

test('일반 생성 제목은 공백만 제거하고 보존한다', async () => {
  const ctx = new Context()
  class LLM extends LLMService {
    async getModel() { return { contextWindow: 8000, maxOutputTokens: 4096 } }
    async countTokens() { return 10 }
    async* stream(): AsyncIterable<LLMEvent> {
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'title', delta: '  정상 제목 😀  ' }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const runtime = await createKeundalChat(ctx, model)
  onTestFinished(async () => {
    await runtime.dispose()
    await store.dispose()
    await llm.dispose()
  })
  expect(await runtime.title({ ...user, parts: [...user.parts] })).toBe('정상 제목 😀')
  expect(validateChatTitle('  ' + '가'.repeat(100) + '  ')).toHaveLength(100)
  expect(() => validateChatTitle('가'.repeat(101))).toThrow('1–100')
  expect(() => validateChatTitle('   ')).toThrow('1–100')
})
