import {
  EventType,
  LLMService,
  STEER_MESSAGE_EVENT,
  SteerQueue,
  isSteerMessage,
  type AGUIEvent,
  type LLMEvent,
  type LLMRequest,
  type RunAgentInput
} from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import type { ExecutableTool } from '@keundal/tools'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: {},
  context: [],
  tools: [],
  messages: [{ id: 'question', role: 'user', content: 'calculate' }]
}

const call = (id = 'call-1'): LLMEvent[] => [
  { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: 'lookup' },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: '{"value":1}' },
  { type: EventType.TOOL_CALL_END, toolCallId: id }
]

const answer = (id: string): LLMEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: 'done' },
  { type: EventType.TEXT_MESSAGE_END, messageId: id }
]

const steerMessage = (id: string) => ({ id, role: 'user' as const, content: id })

const tool: ExecutableTool = {
  name: 'lookup',
  description: 'Look up a value',
  parameters: { type: 'object', properties: {} },
  execute: () => 'result'
}

async function setup(
  t: TestContext,
  options: {
    scripts?: readonly (readonly LLMEvent[])[]
    tools?: ExecutableTool[]
    stream?: (request: LLMRequest) => AsyncIterable<LLMEvent>
  } = {}
) {
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
      const index = requests.length
      requests.push(globalThis.structuredClone(request))
      if (options.stream) return yield* options.stream(request)
      const script = options.scripts?.[index]
      if (!script) throw new Error('unexpected LLM call')
      yield* script
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(agentPlugin, {
    model: 'test',
    maxOutputTokens: 100,
    tools: options.tools ?? [tool]
  })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })
  return { ctx, requests }
}

const drain = async (stream: AsyncIterable<AGUIEvent>) => {
  const collected: AGUIEvent[] = []
  for await (const event of stream) collected.push(event)
  return collected
}

test('도구 실행 중 전달한 지시를 완료된 도구 결과 뒤의 다음 요청에 순서대로 반영한다', async (t) => {
  const steer = new SteerQueue()
  let executed = 0
  const lookup: ExecutableTool = {
    ...tool,
    execute() {
      executed++
      // 도구가 끝나기 전에 도착한 지시는 진행 중인 실행을 중단시키지 않습니다.
      expect(steer.push([steerMessage('steer-1'), steerMessage('steer-2')])).toBe(2)
      return 'result'
    }
  }
  const { ctx, requests } = await setup(t, {
    scripts: [call(), answer('second')],
    tools: [lookup]
  })
  const events = await drain(ctx.agent.run(input, { steer }))
  expect(executed).toBe(1)
  expect(steer.pending).toBe(0)
  expect(requests).toHaveLength(2)
  const messages = requests[1]!.input.messages
  const ids = messages.map((message) => message.id)
  expect(ids.slice(-2)).toEqual(['steer-1', 'steer-2'])
  const toolResult = messages.findIndex((message) => message.role === 'tool')
  expect(toolResult).toBeGreaterThanOrEqual(0)
  expect(messages[toolResult]).toMatchObject({ content: 'result' })
  expect(toolResult).toBeLessThan(ids.indexOf('steer-1'))
  expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1)
  // 지시는 journal에 남아 재생과 복구에서도 같은 위치로 조립됩니다.
  expect(
    events.flatMap((event) =>
      event.type === EventType.CUSTOM && event.name === STEER_MESSAGE_EVENT && isSteerMessage(event.value)
        ? [event.value.id]
        : []
    )
  ).toEqual(['steer-1', 'steer-2'])
})

test('도구 호출이 없는 응답 중 도착한 지시는 실행을 끝내지 않고 다음 요청에 반영한다', async (t) => {
  const steer = new SteerQueue()
  const { ctx, requests } = await setup(t, {
    stream: async function* (request) {
      const steered = request.input.messages.some((message) => message.id === 'steer-late')
      if (!steered) steer.push([steerMessage('steer-late')])
      yield* answer(steered ? 'steered' : 'initial')
    }
  })
  await drain(ctx.agent.run(input, { steer }))
  expect(steer.pending).toBe(0)
  expect(requests).toHaveLength(2)
  expect(requests[1]!.input.messages.at(-1)?.id).toBe('steer-late')
})

test('도구를 등록하지 않은 실행은 지시를 남겨 후속 실행이 처리하게 한다', async (t) => {
  const steer = new SteerQueue()
  const { ctx, requests } = await setup(t, {
    tools: [],
    stream: async function* () {
      // 도구 실행 경계가 없는 단일 생성은 진행 중인 요청을 중단하지 않으므로 지시를 반영하지 않습니다.
      steer.push([steerMessage('during')])
      yield* answer('only')
    }
  })
  await drain(ctx.agent.run(input, { steer }))
  expect(requests).toHaveLength(1)
  expect(steer.pending).toBe(1)
})
