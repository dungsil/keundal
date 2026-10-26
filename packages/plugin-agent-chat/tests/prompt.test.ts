import { AgentConfigSchema } from '@keundal/agent-loop'
import { EventType, type AGUIEvent, type RunAgentInput } from '@keundal/core'
import { LLMService, type LLMEvent, type LLMRequest } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { type PromptPreset } from '@keundal/prompt'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: {},
  context: [],
  tools: [],
  messages: [{ id: 'question', role: 'user', content: 'review' }]
}
const answer: LLMEvent[] = [
  { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'Reviewed' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
]
const SYSTEM_PROMPT_ID = 'keundal:system-prompt'

async function collect(stream: AsyncIterable<AGUIEvent>) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}

async function setup(t: TestContext, systemPrompt?: string) {
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
      yield* answer.map((event) => ({ ...event, messageId: `answer:${request.input.runId}` }))
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  t.onTestFinished(async () => {
    await store.dispose()
    await llm.dispose()
  })
  const agent = await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 100, systemPrompt })
  t.onTestFinished(() => agent.dispose())
  return { ctx, requests }
}

test('설정한 시스템 지침을 실행 입력의 맨 앞에 넣는다', async (t) => {
  const { ctx, requests } = await setup(t, 'Follow the repository rules.')
  await collect(ctx.agent.run(input))
  expect(requests[0].input.messages[0]).toStrictEqual({
    id: SYSTEM_PROMPT_ID,
    role: 'system',
    content: 'Follow the repository rules.'
  })
})

test('지침을 설정하지 않으면 시스템 메시지를 추가하지 않는다', async (t) => {
  const { ctx, requests } = await setup(t)
  await collect(ctx.agent.run(input))
  expect(requests[0].input.messages.map((message) => message.role)).toEqual(['user'])
})

test('세션이 이전 지침을 반환하면 같은 ID의 현재 지침으로 대체한다', async (t) => {
  const { ctx, requests } = await setup(t, 'First instruction.')
  await collect(ctx.agent.run(input))
  await ctx.session.commit({
    threadId: 'thread',
    expectedRevision: 1,
    messages: [{ id: SYSTEM_PROMPT_ID, role: 'system', content: 'Stale instruction.' }],
    state: {}
  })
  await collect(ctx.agent.run({ ...input, runId: 'second' }))
  const prompts = requests[1].input.messages.filter((message) => message.id === SYSTEM_PROMPT_ID)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]?.content).toBe('First instruction.')
})

test('예약 ID를 입력 메시지에 쓰면 생성을 시작하기 전에 거부한다', async (t) => {
  const { ctx, requests } = await setup(t, 'Follow the repository rules.')
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

test('빈 시스템 지침과 기본값이 아닌 형식은 설정을 거부한다', async () => {
  for (const systemPrompt of ['', '   ', 42, null]) {
    const result = await AgentConfigSchema['~standard'].validate({
      model: 'test',
      maxOutputTokens: 100,
      systemPrompt
    })
    expect(result.issues).toBeDefined()
  }
})

test('프리셋은 준비된 세션 기록 앞뒤에 조립하고 다음 실행에서 바꾸거나 해제할 수 있다', async (t) => {
  const { ctx, requests } = await setup(t, 'Base rules')
  await ctx.session.commit({
    threadId: 'thread',
    expectedRevision: 0,
    state: {},
    messages: [
      { id: 'old-user', role: 'user', content: 'Earlier question' },
      { id: 'old-answer', role: 'assistant', content: 'Earlier answer' }
    ]
  })
  const preset: PromptPreset = {
    id: 'review',
    name: 'Review',
    variables: { language: 'Korean' },
    blocks: [
      { id: 'before', type: 'text', name: 'Before', enabled: true, role: 'system', content: 'Use {{language}}' },
      { id: 'history', type: 'history', name: 'History', enabled: true },
      { id: 'after', type: 'text', name: 'After', enabled: true, role: 'user', content: 'Check the risks' }
    ]
  }
  await collect(ctx.agent.run({ ...input, forwardedProps: { keundalPromptPreset: preset } }))
  expect(requests[0].input.messages.map(({ role, content }) => [role, content])).toEqual([
    ['system', 'Base rules'],
    ['system', 'Use Korean'],
    ['user', 'Earlier question'],
    ['assistant', 'Earlier answer'],
    ['user', 'review'],
    ['user', 'Check the risks']
  ])
  preset.variables.language = 'English'
  await collect(ctx.agent.run({ ...input, runId: 'changed', forwardedProps: { keundalPromptPreset: preset } }))
  expect(
    requests[1].input.messages.filter(({ id }) => id.startsWith('keundal:prompt:')).map(({ content }) => content)
  ).toEqual(['Use English', 'Check the risks'])
  await collect(ctx.agent.run({ ...input, runId: 'disabled' }))
  expect(requests[2].input.messages.some(({ id }) => id.startsWith('keundal:prompt:'))).toBe(false)
  expect((await ctx.session.get('thread'))?.messages.some(({ id }) => id.startsWith('keundal:prompt:'))).toBe(false)
})

test('잘못된 프리셋과 예약 블록 ID는 모델 호출 전에 거부한다', async (t) => {
  const { ctx, requests } = await setup(t)
  await expect(
    collect(ctx.agent.run({ ...input, forwardedProps: { keundalPromptPreset: { blocks: [] } } }))
  ).rejects.toThrow()
  await expect(
    collect(ctx.agent.run({ ...input, messages: [{ id: 'keundal:prompt:spoof', role: 'user', content: 'Invalid' }] }))
  ).rejects.toThrow('message id is reserved for prompt presets')
  expect(requests).toHaveLength(0)
})
