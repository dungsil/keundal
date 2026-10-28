import { createServer } from 'node:http'

import { parseRunBudget, type RunBudget } from '@keundal/agent'
import { createAgentHost, type AgentHostRunOptions } from '@keundal/agent-host'
import { createAgentApp } from '@keundal/agent-host/http'
import { RemoteChatStore } from '@keundal/chat-http'
import { EventType, type RunAgentInput } from '@keundal/core'
import { LLMService, type LLMEvent, type LLMRequest } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import { ChatStore, type MountAgent } from '@keundal/plugin-chat-local'
import memoryStore from '@keundal/plugin-store-memory'
import { expect, onTestFinished, test } from 'vitest'

const user = { id: 'user', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hello' }] }
const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: {},
  context: [],
  tools: [],
  messages: [{ id: 'user', role: 'user', content: 'hello' }]
}
const mountAgent: MountAgent = async (ctx, config) => ctx.plugin(agentPlugin, { ...config, budget: { maxTokens: 1 } })

async function setup() {
  const calls: { title: boolean }[] = []
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 8000, maxOutputTokens: 4096 }
    }
    async countTokens() {
      return 10
    }
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
      const title = request.input.messages.some(
        (message) => message.role === 'system' && message.content.startsWith('Generate a chat title')
      )
      calls.push({ title })
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: title ? 'Chat title' : 'hello' }
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
    }
  }
  const host = await createAgentHost({
    model: 'test',
    models: [{ id: 'test', provider: 'openai', contextWindow: 8000, maxOutputTokens: 4096 }],
    setup: async (ctx) => {
      await ctx.plugin(LLM)
      await ctx.plugin(memoryStore)
    },
    mountAgent
  })
  const executions: { input: RunAgentInput; options?: AgentHostRunOptions }[] = []
  const run = host.services.run.bind(host.services)
  host.services.run = (input, options) => {
    executions.push({ input, options })
    return run(input, options)
  }
  const server = createServer(createAgentApp(host.services, { token: 'test-token' }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await host.dispose()
  })
  const endpoint = `http://127.0.0.1:${address.port}`
  const post = (body: unknown) =>
    fetch(`${endpoint}/runs`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  return { host, endpoint, post, calls, executions }
}

test('공개 예산 파서는 비용 통화를 정리하고 기본 가격 정책을 반환한다', () => {
  expect(parseRunBudget({ maxTokens: 100, maxCost: { amount: 0, currency: ' USD ' }, maxDurationMs: 200 })).toEqual({
    maxTokens: 100,
    maxCost: { amount: 0, currency: 'USD' },
    maxDurationMs: 200,
    unknownPricing: 'reject'
  })
  expect(parseRunBudget({})).toEqual({ unknownPricing: 'reject' })
  expect(parseRunBudget({ unknownPricing: 'allow' })).toEqual({ unknownPricing: 'allow' })
})

const invalidBudgets = [
  null,
  [],
  '1',
  1,
  { extra: 1 },
  { maxTokens: 0 },
  { maxTokens: -1 },
  { maxTokens: 1.5 },
  { maxTokens: '1' },
  { maxTokens: Number.MAX_SAFE_INTEGER + 1 },
  { maxDurationMs: 0 },
  { maxDurationMs: 2_147_483_648 },
  { unknownPricing: 'ignore' },
  { maxCost: null },
  { maxCost: [] },
  { maxCost: { amount: -1, currency: 'USD' } },
  { maxCost: { amount: 1, currency: ' ' } },
  { maxCost: { amount: 1 } },
  { maxCost: { amount: 1, currency: 'USD', extra: true } }
]

test('공개 예산 파서는 잘못된 값과 유한하지 않은 수를 거부한다', () => {
  for (const budget of [
    ...invalidBudgets,
    undefined,
    { maxTokens: Infinity },
    { maxCost: { amount: NaN, currency: 'USD' } }
  ]) {
    expect(() => parseRunBudget(budget)).toThrow('budget')
  }
})

test('HTTP는 잘못된 예산을 실행 등록 전에 거부한다', async () => {
  const fixture = await setup()
  for (const budget of invalidBudgets) {
    const response = await fixture.post({ ...input, budget })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid request' })
  }
  expect(fixture.executions).toEqual([])
  expect(await fixture.host.services.generation.list()).toEqual([])
  expect(fixture.calls).toEqual([])
})

test('HTTP는 예산을 입력 상태가 아닌 실행 옵션으로 전달하고 생략한 값은 추가하지 않는다', async () => {
  const fixture = await setup()
  const response = await fixture.post({
    ...input,
    budget: { maxTokens: 10000, maxCost: { amount: 1, currency: ' USD ' }, unknownPricing: 'allow' }
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('RUN_FINISHED')
  expect(fixture.executions[0]?.options?.budget).toEqual({
    maxTokens: 10000,
    maxCost: { amount: 1, currency: 'USD' },
    unknownPricing: 'allow'
  })
  expect(fixture.executions[0]?.input).not.toHaveProperty('budget')
  const omitted = await fixture.post({ ...input, runId: 'omitted' })
  expect(await omitted.text()).toContain('run budget exceeded: tokens')
  expect(fixture.executions[1]?.options).not.toHaveProperty('budget')
})

test.each(['browser', 'host'] as const)(
  '%s 저장소는 요청 예산을 적용하고 제목·다음 요청·기본 예산을 분리한다',
  async (execution) => {
    const fixture = await setup()
    const bodies: { path: string; body: Record<string, unknown> }[] = []
    const request: typeof fetch = (url, init) => {
      if (init?.body && typeof init.body === 'string')
        bodies.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) as Record<string, unknown> })
      return fetch(url, init)
    }
    const store =
      execution === 'browser'
        ? new ChatStore(fixture.host.ctx, mountAgent)
        : new RemoteChatStore({ endpoint: fixture.endpoint, token: 'test-token' }, request)
    onTestFinished(() => store.stop())
    const policies: { budget?: RunBudget; success: boolean }[] = [
      { budget: { maxTokens: 1 }, success: false },
      { budget: {}, success: true },
      { budget: { maxTokens: 10000 }, success: true },
      { success: false }
    ]
    const id = 'chat'
    await store.create(id, user, 'openai/test')
    for (const policy of policies) {
      const events = await Array.fromAsync(
        store.respond(id, {
          model: 'openai/test',
          messages: [user],
          ...(policy.budget === undefined ? {} : { budget: policy.budget })
        })
      )
      expect(events.at(-1)?.type).toBe(policy.success ? EventType.RUN_FINISHED : EventType.RUN_ERROR)
      if (!policy.success)
        expect(events.at(-1)).toMatchObject({ message: expect.stringContaining('run budget exceeded: tokens') })
      expect((await store.get(id))?.title).toBe('Chat title')
    }
    expect(fixture.calls.filter((call) => call.title)).toHaveLength(1)
    expect(fixture.calls.filter((call) => !call.title)).toHaveLength(2)
    const before = await store.get(id)
    await expect(
      Array.fromAsync(store.respond(id, { model: 'openai/test', messages: [user], budget: { maxTokens: 0 } }))
    ).rejects.toThrow('budget.maxTokens')
    expect(await store.get(id)).toEqual(before)
    if (execution === 'host') {
      const titles = bodies.filter((entry) => entry.path === '/title')
      expect(titles).toHaveLength(1)
      expect(titles[0]?.body).not.toHaveProperty('budget')
      const runs = bodies.filter((entry) => entry.path === '/runs')
      expect(runs).toHaveLength(4)
      expect(runs[0]?.body.budget).toEqual({ maxTokens: 1, unknownPricing: 'reject' })
      expect(runs[3]?.body).not.toHaveProperty('budget')
    }
  }
)
