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

test('에이전트와 메모리 저장소를 조합하면 축약 후 커밋하고 원본 이력을 보존한다', async (t) => {
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

test('축약 후 입력이 예산 안에 들면 재카운트 없이 실행한다', async (t) => {
  const ctx = new Context()
  const counts: { maxOutputTokens?: number; hasSummary: boolean }[] = []
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    constructor(ctx: Context) {
      super(ctx)
    }
    async getModel() {
      return { contextWindow: 2400, maxOutputTokens: 1000 }
    }
    async countTokens(request: LLMRequest) {
      counts.push({
        maxOutputTokens: request.maxOutputTokens,
        hasSummary: request.input.messages.some(
          (message) =>
            'content' in message && typeof message.content === 'string' && message.content.includes('Earlier facts.')
        )
      })
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
    maxOutputTokens: 200,
    compaction: { keepRecentMessages: 1, maxSummaryTokens: 100 }
  })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
  })

  const events = []
  for await (const event of ctx.agent.run(input)) events.push(event)

  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  // 첫 카운트만 에이전트의 출력 예산(200)이고, 이후 카운트는 모두 compact() 내부의 요약 예산(100)이다.
  expect(counts[0]).toStrictEqual({ maxOutputTokens: 200, hasSummary: false })
  expect(counts.length).toBeGreaterThan(2)
  expect(counts.slice(1).every((count) => count.maxOutputTokens === 100)).toBe(true)
  expect(counts.at(-1)?.hasSummary).toBe(true)
  const generation = await ctx.generation.get(input.runId)
  expect(generation?.request.compaction?.sourceMessageIds).toStrictEqual(['old-user', 'old-assistant'])
})
