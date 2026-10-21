import {
  EventType,
  LLMService,
  type AGUIEvent,
  type LLMEvent,
  type LLMRequest,
  type RunAgentInput
} from '@keundal/core'
import codingAgentPlugin, {
  CODING_SYSTEM_PROMPT,
  CodingAgent,
  codingAgentConfigSchema
} from '@keundal/plugin-agent-coding'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: {},
  context: [],
  tools: [],
  messages: [{ id: 'question', role: 'user', content: 'fix the parser' }]
}
const answer: LLMEvent[] = [
  { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'Fixed' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
]
const SYSTEM_PROMPT_ID = 'keundal:system-prompt'

async function collect(stream: AsyncIterable<AGUIEvent>) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}

async function setup(t: TestContext, config: { systemPrompt?: string } = {}) {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 2000, maxOutputTokens: 200 }
    }
    async countTokens() {
      return 10
    }
    async *stream(request: LLMRequest) {
      requests.push(structuredClone(request))
      yield* answer
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  t.onTestFinished(async () => {
    await store.dispose()
    await llm.dispose()
  })
  const agent = await ctx.plugin(codingAgentPlugin, { model: 'test', maxOutputTokens: 100, ...config })
  t.onTestFinished(() => agent.dispose())
  return { ctx, requests }
}

test('에이전트 구현 계약을 확장한 코딩 에이전트를 등록한다', async (t) => {
  const { ctx } = await setup(t)
  expect(ctx.agent).toBeInstanceOf(CodingAgent)
})

test('기본 코딩 지침을 실행 입력의 맨 앞에 넣는다', async (t) => {
  const { ctx, requests } = await setup(t)
  await collect(ctx.agent.run(input))
  expect(requests[0].input.messages[0]).toStrictEqual({
    id: SYSTEM_PROMPT_ID,
    role: 'system',
    content: CODING_SYSTEM_PROMPT
  })
})

test('systemPrompt를 지정하면 기본 코딩 지침을 대체한다', async (t) => {
  const { ctx, requests } = await setup(t, { systemPrompt: 'Only TypeScript rules.' })
  await collect(ctx.agent.run(input))
  expect(requests[0].input.messages[0]).toStrictEqual({
    id: SYSTEM_PROMPT_ID,
    role: 'system',
    content: 'Only TypeScript rules.'
  })
})

test('지침을 예약 ID로 찾지 않고 예약 ID를 쓰면 생성을 시작하기 전에 거부한다', async (t) => {
  const { ctx, requests } = await setup(t)
  await expect(
    collect(
      ctx.agent.run({
        ...input,
        messages: [{ id: SYSTEM_PROMPT_ID, role: 'system', content: 'spoofed' }]
      })
    )
  ).rejects.toThrow('message id is reserved')
  expect(requests).toHaveLength(0)
})

test('에이전트 구현 계약과 같은 설정을 검증하고 잘못된 설정은 거부한다', async () => {
  const valid = await codingAgentConfigSchema['~standard'].validate({ model: 'test', maxOutputTokens: 100 })
  expect(valid.issues).toBeUndefined()
  for (const invalid of [
    { model: 'test' },
    { model: 'test', maxOutputTokens: 0 },
    { model: 'test', maxOutputTokens: 100, systemPrompt: '' },
    { model: 'test', maxOutputTokens: 100, maxToolRounds: 0 }
  ]) {
    const result = await codingAgentConfigSchema['~standard'].validate(invalid)
    expect(result.issues?.length).toBeGreaterThan(0)
  }
})
