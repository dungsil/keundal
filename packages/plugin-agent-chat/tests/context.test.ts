import { appendContext, CONTEXT_MESSAGE_PREFIX, type ContextProvider } from '@keundal/context'
import {
  CONTEXT_MESSAGE_EVENT,
  EventType,
  LLMService,
  type AGUIEvent,
  type LLMEvent,
  type LLMRequest,
  type RunAgentInput
} from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-chat'
import contextPlugin from '@keundal/plugin-context'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'context-thread',
  runId: 'first',
  state: {},
  tools: [],
  context: [],
  messages: [{ id: 'user', role: 'user', content: 'Inspect and update the workspace.' }]
}

async function collect(stream: AsyncIterable<AGUIEvent>) {
  const events: AGUIEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

async function setup(t: TestContext, providers: ContextProvider[], useTools = false) {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  let workspace = 'before'
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 20000, maxOutputTokens: 1000 }
    }
    async countTokens(request: LLMRequest) {
      return JSON.stringify(request.input).length
    }
    async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push(structuredClone(request))
      if (useTools && requests.length === 1) {
        yield { type: EventType.TOOL_CALL_START, toolCallId: 'edit-call', toolCallName: 'update' }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'edit-call', delta: '{}' }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'edit-call' }
      } else {
        const id = `answer-${requests.length}`
        yield { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: 'Updated.' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: id }
      }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const context = await ctx.plugin(contextPlugin, {
    providers: [
      ...providers,
      ...(useTools ? [(request: RunAgentInput) => appendContext(request, 'workspace', workspace)] : [])
    ]
  })
  const agent = await ctx.plugin(agentPlugin, {
    model: 'test',
    maxOutputTokens: 1000,
    context: true,
    tools: useTools
      ? [
          {
            name: 'update',
            description: 'Update workspace',
            parameters: { type: 'object' },
            execute: () => {
              workspace = 'after'
              return 'Updated'
            }
          }
        ]
      : []
  })
  t.onTestFinished(async () => {
    await agent.dispose()
    await context.dispose()
    await store.dispose()
    await llm.dispose()
  })
  return { ctx, requests, context }
}

test('도구 실행 전후의 컨텍스트를 저장하고 다음 실행에서 중복으로 추가하지 않는다', async (t) => {
  const { ctx, requests } = await setup(t, [], true)
  const events = await collect(ctx.agent.run(input))
  const contexts = (request: LLMRequest) =>
    request.input.messages
      .filter((message) => message.id.startsWith(CONTEXT_MESSAGE_PREFIX))
      .map((message) => message.content)
  expect(contexts(requests[0])).toEqual(['before'])
  expect(contexts(requests[1])).toEqual(['before', 'after'])
  const session = await ctx.session.get(input.threadId)
  expect(
    session?.messages
      .filter((message) => message.id.startsWith(CONTEXT_MESSAGE_PREFIX))
      .map((message) => message.content)
  ).toEqual(['before', 'after'])
  expect(
    events.filter((event) => event.type === EventType.CUSTOM && event.name === CONTEXT_MESSAGE_EVENT)
  ).toHaveLength(2)
  const nextEvents = await collect(
    ctx.agent.run({ ...input, runId: 'second', messages: [{ id: 'next', role: 'user', content: 'Continue.' }] })
  )
  expect(contexts(requests[2])).toEqual(['before', 'after'])
  expect(nextEvents.filter((event) => event.type === EventType.CUSTOM && event.name === CONTEXT_MESSAGE_EVENT)).toEqual(
    []
  )
})

test('도구가 없는 실행에서도 컨텍스트를 커밋하고 복구 때 공급자를 다시 실행하지 않는다', async (t) => {
  let reads = 0
  const { ctx } = await setup(t, [
    (request) => {
      reads++
      return appendContext(request, 'instructions', 'Use local conventions.')
    }
  ])
  await collect(ctx.agent.run(input))
  expect((await ctx.session.get(input.threadId))?.messages[0].content).toBe('Use local conventions.')
  const recovered = await ctx.generation.recover()
  expect(recovered[0].messages[0].content).toBe('Use local conventions.')
  expect(reads).toBe(1)
})

test('컨텍스트 준비가 취소되면 모델 호출과 세션 커밋을 시작하지 않는다', async (t) => {
  const entered = Promise.withResolvers<void>()
  const { ctx, requests } = await setup(t, [
    async (request, { signal }) => {
      entered.resolve()
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
      return appendContext(request, 'cancelled', 'must not publish')
    }
  ])
  const controller = new AbortController()
  const running = collect(ctx.agent.run(input, { signal: controller.signal }))
  const rejection = expect(running).rejects.toThrow('cancel context')
  await entered.promise
  controller.abort(new Error('cancel context'))
  await rejection
  expect(requests).toEqual([])
  expect(await ctx.session.get(input.threadId)).toBeUndefined()
})

test('사용자 입력에서 컨텍스트 예약 ID를 위조하면 준비 전에 거부한다', async (t) => {
  const { ctx, requests } = await setup(t, [])
  await expect(
    collect(
      ctx.agent.run({ ...input, messages: [{ id: `${CONTEXT_MESSAGE_PREFIX}spoof`, role: 'user', content: 'spoof' }] })
    )
  ).rejects.toThrow('reserved')
  expect(requests).toEqual([])
})
