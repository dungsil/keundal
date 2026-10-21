import { Context } from 'cordis'
import { EventType, LLMService, TRACE_EVENT, readTraceSpans } from '@keundal/core'
import type { AGUIEvent, LLMEvent } from '@keundal/core'
import type { ChatMessage } from '@keundal/chat/chat-message'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { ChatStore } from '@keundal/plugin-chat-local'
import { expect, test } from 'vitest'
import { mountAgent } from './fixtures/agent'
import { useKeundalChat } from '../app/composables/useKeundalChat'

test('공급자가 첫 응답을 보류해도 실행 ID와 모델의 실행 중 Trace를 먼저 제공한다', async (t) => {
  const release = Promise.withResolvers<void>()
  const modelStarted = Promise.withResolvers<void>()
  const ctx = new Context()
  class LLM extends LLMService {
    async getModel() { return { contextWindow: 128000, maxOutputTokens: 4096 } }
    async countTokens() { return 40 }
    async *stream(): AsyncGenerator<LLMEvent> {
      await release.promise
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'Live trace works.' }
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
    }
  }
  const llm = await ctx.plugin(LLM)
  const storage = await ctx.plugin(memoryStorePlugin)
  const chats = new ChatStore(ctx, mountAgent)
  t.onTestFinished(async () => {
    release.resolve()
    await chats.stop()
    await storage.dispose()
    await llm.dispose()
  })
  const user: ChatMessage = { id: 'question', role: 'user', parts: [{ type: 'text', text: 'Show live progress.' }] }
  await chats.create('live-trace-chat', user, 'openai/test')
  await chats.rename('live-trace-chat', 'Existing title')
  const observed: AGUIEvent[] = []
  let runId: string | undefined
  const client = useKeundalChat({
    respond: (messages, onMessage, signal) => chats.respond('live-trace-chat', { messages, model: 'openai/test', onMessage }, signal),
    onEvent(event) {
      observed.push(event)
      if (event.type === EventType.RUN_STARTED) runId = event.runId
      if (event.type === EventType.CUSTOM && event.name === TRACE_EVENT) {
        const span = readTraceSpans([event])[0]
        if (span?.kind === 'model' && span.status === 'running') modelStarted.resolve()
      }
    }
  })
  client.messages.value = [user]
  const running = client.regenerate()
  await modelStarted.promise
  expect(client.status.value).toBe('streaming')
  expect(client.messages.value.at(-1)).toMatchObject({ id: runId, role: 'assistant', parts: [] })
  expect(observed.filter(event => event.type !== EventType.CUSTOM).map(event => event.type)).toEqual([EventType.RUN_STARTED])
  const spans = readTraceSpans(observed, runId)
  const root = spans.find(span => span.kind === 'agent')!
  expect(spans.find(span => span.kind === 'model')).toMatchObject({ status: 'running', parentSpanId: root.spanId })
  release.resolve()
  await running
  expect(client.status.value).toBe('ready')
  expect(client.error.value).toBeUndefined()
  expect(client.messages.value.at(-1)?.parts).toContainEqual({ type: 'text', text: 'Live trace works.' })
})
