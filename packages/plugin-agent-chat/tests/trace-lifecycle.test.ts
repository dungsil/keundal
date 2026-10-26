import type { AgentConfig } from '@keundal/agent-loop'
import { EventType, type AGUIEvent, type RunAgentInput } from '@keundal/core'
import { LLMService, type LLMEvent, type LLMRequest } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { LLM_USAGE_EVENT, readTraceSpans } from '@keundal/trace'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'trace-lifecycle-thread',
  runId: 'trace-lifecycle-run',
  state: {},
  context: [],
  tools: [],
  messages: [{ id: 'question', role: 'user', content: 'Summarize this history' }]
}

async function setup(
  t: TestContext,
  stream: (request: LLMRequest) => AsyncIterable<LLMEvent>,
  config: Partial<AgentConfig> = {},
  countTokens: (request: LLMRequest) => number = () => 10
) {
  const ctx = new Context()
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 1000, maxOutputTokens: 100 }
    }
    async countTokens(request: LLMRequest) {
      return countTokens(request)
    }
    stream(request: LLMRequest) {
      return stream(request)
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(agentPlugin, { model: 'trace-lifecycle-model', maxOutputTokens: 100, ...config })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })
  return ctx
}

function* answer(): Generator<LLMEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'done' }
  yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
}

function spans(events: readonly AGUIEvent[], runId: string) {
  return readTraceSpans(events, runId)
}

test('커밋 실패 후 terminal snapshot의 root Trace 상태를 generation 상태와 맞춘다', async (t) => {
  const ctx = await setup(t, async function* () {
    yield* answer()
  })
  Object.defineProperty(ctx.session, 'commit', {
    configurable: true,
    value: async () => {
      throw new Error('private commit failure')
    }
  })

  const emitted: AGUIEvent[] = []
  await expect(
    (async () => {
      for await (const event of ctx.agent.run(input)) emitted.push(event)
    })()
  ).rejects.toThrow('private commit failure')

  const saved = await ctx.generation.get(input.runId)
  expect(saved?.status).toBe('interrupted')
  expect(
    spans(
      saved!.journal.map(({ event }) => event),
      input.runId
    ).find((span) => span.kind === 'agent')
  ).toMatchObject({ status: 'interrupted' })
  expect(spans(emitted, input.runId).find((span) => span.kind === 'agent')).toMatchObject({ status: 'completed' })
})

test('실행 종료 시 detached background Trace는 최신 사용량을 보존하고 종료 사실을 만들지 않는다', async (t) => {
  const usageSeen = Promise.withResolvers<void>()
  const releaseBackground = Promise.withResolvers<void>()
  t.onTestFinished(() => releaseBackground.resolve())
  const backgroundUsage = {
    source: 'provider',
    inputTokens: 31,
    outputTokens: 7,
    cacheReadTokens: 11,
    cacheWriteTokens: 2
  }
  const ctx = await setup(
    t,
    async function* (request) {
      const background = request.input.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.startsWith('Summarize the conversation data')
      )
      if (background) {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'summary', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'summary', delta: 'saved summary' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'summary' }
        yield { type: EventType.CUSTOM, name: LLM_USAGE_EVENT, value: backgroundUsage } as LLMEvent
        usageSeen.resolve()
        await releaseBackground.promise
        return
      }
      await usageSeen.promise
      yield* answer()
    },
    { compaction: { threshold: 0.5 } },
    (request) =>
      request.input.messages.reduce(
        (sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0),
        0
      )
  )

  const longHistory: RunAgentInput = {
    ...input,
    runId: 'detached-background-run',
    messages: Array.from({ length: 10 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: 'x'.repeat(60)
    }))
  }
  const events: AGUIEvent[] = []
  for await (const event of ctx.agent.run(longHistory)) events.push(event)
  releaseBackground.resolve()

  const saved = await ctx.generation.get(longHistory.runId)
  const observed = spans(
    saved!.journal.map(({ event }) => event),
    longHistory.runId
  )
  const container = observed.find((span) => span.kind === 'compaction' && span.name === 'background_prepare')
  const model = observed.find((span) => span.kind === 'model' && span.parentSpanId === container?.spanId)
  expect(container).toMatchObject({ detached: true, status: 'running' })
  expect(container).not.toHaveProperty('endedAt')
  expect(model).toMatchObject({ detached: true, status: 'running', usage: backgroundUsage })
  expect(model).not.toHaveProperty('endedAt')
})
