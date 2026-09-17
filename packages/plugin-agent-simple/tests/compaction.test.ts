import { EventType, LLMService, type LLMEvent, type LLMRequest } from '@keundal/core'
import type { RunAgentInput } from '@keundal/core'
import simpleAgentPlugin from '@keundal/plugin-agent-simple'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test } from 'vitest'
const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: { untouched: true },
  tools: [],
  context: [],
  messages: [
    { id: 'system', role: 'system', content: 'Keep this instruction' },
    { id: 'old-user', role: 'user', content: 'old question '.repeat(100) },
    { id: 'old-assistant', role: 'assistant', content: 'old answer '.repeat(100) },
    { id: 'recent', role: 'user', content: 'continue' }
  ]
}

async function* response(): AsyncIterable<LLMEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: 'summary', role: 'assistant' }
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'summary', delta: 'Earlier facts.' }
  yield { type: EventType.TEXT_MESSAGE_END, messageId: 'summary' }
}

test('composes with the agent and memory store, commits after compaction, and retains original history', async (t) => {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    constructor(ctx: Context) {
      super(ctx)
    }
    async getModel() {
      return { contextWindow: 2400, maxOutputTokens: 1000 }
    }
    async countTokens(request: LLMRequest) {
      return JSON.stringify(request.input).length
    }
    stream(request: LLMRequest) {
      requests.push(request)
      return response()
    }
  }
  const llm = await ctx.plugin(LLM)
  t.onTestFinished(() => llm.dispose())
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(simpleAgentPlugin, {
    model: 'test',
    maxOutputTokens: 100,
    compaction: { keepRecentMessages: 1, maxSummaryTokens: 100 }
  })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
  })
  await ctx.session.commit({
    threadId: input.threadId,
    expectedRevision: 0,
    messages: input.messages,
    state: input.state
  })
  const events = []
  for await (const event of ctx.agent.run({ ...input, messages: [] })) events.push(event)
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(requests.length).toBeGreaterThan(1)
  const generation = await ctx.generation.get(input.runId)
  expect(generation?.request.compaction?.sourceMessageIds).toStrictEqual(['old-user', 'old-assistant'])
  const session = await ctx.session.get(input.threadId)
  for (const message of input.messages) expect(session?.messages).toContainEqual(message)
})
