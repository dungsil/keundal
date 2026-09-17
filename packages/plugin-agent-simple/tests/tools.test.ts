import { getEventListeners } from 'node:events'

import {
  EventType,
  LLMService,
  parseAGUIEvent,
  type AGUIEvent,
  type ExecutionOptions,
  type LLMEvent,
  type LLMRequest,
  type RunAgentInput
} from '@keundal/core'
import simpleAgentPlugin, {
  SimpleAgentConfigSchema,
  type ExecutableTool,
  type SimpleAgentConfig,
  type ToolExecutionContext
} from '@keundal/plugin-agent-simple'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: { selected: true },
  context: [{ description: 'language', value: 'ko' }],
  tools: [],
  messages: [{ id: 'question', role: 'user', content: 'calculate' }]
}
const answer: LLMEvent[] = [
  { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'done' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
]
const call = (id = 'call-1', args = '{"value":1}', name = 'lookup'): LLMEvent[] => [
  { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args },
  { type: EventType.TOOL_CALL_END, toolCallId: id }
]
const tool = (execute: ExecutableTool['execute'] = () => 'result'): ExecutableTool => ({
  name: 'lookup',
  description: 'Look up a value',
  parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
  execute
})
async function collect(stream: AsyncIterable<AGUIEvent>) {
  const events: AGUIEvent[] = []
  for await (const event of stream) events.push(parseAGUIEvent(event))
  return events
}

async function setup(
  t: TestContext,
  scripts: readonly (readonly LLMEvent[])[],
  config: Partial<SimpleAgentConfig> = {},
  overrides: { stream?: LLMService['stream']; countTokens?: LLMService['countTokens'] } = {}
) {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  const counted: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 2000, maxOutputTokens: 200 }
    }
    async countTokens(request: LLMRequest, options?: ExecutionOptions) {
      counted.push(globalThis.structuredClone(request))
      return overrides.countTokens ? overrides.countTokens(request, options) : 10
    }
    async *stream(request: LLMRequest, options?: ExecutionOptions) {
      const index = requests.length
      requests.push(globalThis.structuredClone(request))
      if (overrides.stream) yield* overrides.stream(request, options)
      else {
        if (!scripts[index]) throw new Error('unexpected LLM call')
        yield* scripts[index]
      }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(simpleAgentPlugin, {
    model: 'test',
    maxOutputTokens: 100,
    tools: [tool()],
    ...config
  })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })
  return { ctx, requests, counted, agent }
}

test('교차 수신한 호출 인자를 모아 순서대로 실행하고 결과와 추론 서명을 후속 생성에 전달한다', async (t) => {
  const executed: { args: Record<string, unknown>; context: ToolExecutionContext }[] = []
  const { ctx, requests, counted } = await setup(
    t,
    [
      [
        { type: EventType.REASONING_MESSAGE_START, messageId: 'reason', role: 'reasoning' },
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'reason', delta: 'thinking' },
        { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId: 'reason', encryptedValue: 'opaque' },
        { type: EventType.TEXT_MESSAGE_START, messageId: 'working', role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'working', delta: 'checking' },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'working' },
        { type: EventType.TOOL_CALL_START, toolCallId: 'first', toolCallName: 'lookup' },
        { type: EventType.TOOL_CALL_START, toolCallId: 'second', toolCallName: 'lookup' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'first', delta: '{"value":' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'second', delta: '{"value":2}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'second' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'first', delta: '1}' },
        {
          type: EventType.REASONING_ENCRYPTED_VALUE,
          subtype: 'tool-call',
          entityId: 'first',
          encryptedValue: 'signature'
        },
        { type: EventType.TOOL_CALL_END, toolCallId: 'first' }
      ],
      answer
    ],
    {
      tools: [
        tool(async (args, context) => {
          if (context.toolCallId === 'second') {
            expect((await ctx.generation.get('run'))?.messages).toContainEqual({
              id: expect.any(String),
              role: 'tool',
              toolCallId: 'first',
              content: 'value:1'
            })
          }
          executed.push({ args, context })
          return `value:${args.value}`
        })
      ]
    }
  )
  const events: AGUIEvent[] = []
  for await (const event of ctx.agent.run(input)) {
    events.push(parseAGUIEvent(event))
    if (event.type === EventType.RUN_FINISHED) {
      expect((await ctx.session.get('thread'))?.messages.at(-1)).toEqual({
        id: 'answer',
        role: 'assistant',
        content: 'done'
      })
    }
  }
  expect(executed.map(({ args, context }) => [args, context.toolCallId])).toEqual([
    [{ value: 1 }, 'first'],
    [{ value: 2 }, 'second']
  ])
  expect(executed[0].context).toMatchObject({
    threadId: 'thread',
    runId: 'run',
    signal: expect.any(globalThis.AbortSignal)
  })
  expect(requests).toHaveLength(2)
  expect(counted).toHaveLength(2)
  expect(requests[0].input.tools).toEqual([
    { name: 'lookup', description: 'Look up a value', parameters: tool().parameters }
  ])
  expect(requests[1].input).toMatchObject({
    threadId: 'thread',
    runId: 'run',
    state: input.state,
    context: input.context
  })
  expect(requests[1].input.messages).toEqual([
    ...input.messages,
    { id: 'reason', role: 'reasoning', content: 'thinking', encryptedValue: 'opaque' },
    {
      id: 'working',
      role: 'assistant',
      content: 'checking',
      toolCalls: [
        {
          id: 'first',
          type: 'function',
          function: { name: 'lookup', arguments: '{"value":1}' },
          encryptedValue: 'signature'
        },
        { id: 'second', type: 'function', function: { name: 'lookup', arguments: '{"value":2}' } }
      ]
    },
    { id: expect.any(String), role: 'tool', toolCallId: 'first', content: 'value:1' },
    { id: expect.any(String), role: 'tool', toolCallId: 'second', content: 'value:2' }
  ])
  expect(events.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1)
  expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1)
  const stored = await ctx.generation.get('run')
  expect(stored?.status).toBe('completed')
  expect(stored?.journal.map(({ event }) => event)).toEqual(events)
  expect((await ctx.session.get('thread'))?.revision).toBe(1)
  expect(input.tools).toEqual([])
  expect(input.messages).toHaveLength(1)
})

test('여러 후속 생성의 도구 전용 메시지를 결과 순서대로 저장하고 실행을 한 번만 커밋한다', async (t) => {
  const { ctx, requests } = await setup(t, [call('first'), call('second'), answer])
  await collect(ctx.agent.run(input))
  expect(requests).toHaveLength(3)
  const messages = (await ctx.session.get('thread'))?.messages
  expect(messages?.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant'])
  expect(messages?.[0]).toMatchObject({ id: 'first', toolCalls: [{ id: 'first' }] })
  expect(messages?.[2]).toMatchObject({ id: 'second', toolCalls: [{ id: 'second' }] })
  expect((await ctx.session.get('thread'))?.revision).toBe(1)
})

test('실행 함수를 등록하지 않으면 기존처럼 도구 호출 이벤트만 전달한다', async (t) => {
  const { ctx, requests } = await setup(t, [call()], { tools: [] })
  const events = await collect(
    ctx.agent.run({ ...input, tools: [{ name: 'lookup', description: '', parameters: {} }] })
  )
  expect(requests).toHaveLength(1)
  expect(events.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toHaveLength(0)
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
})

for (const [label, events, error] of [
  ['잘못된 JSON', call('bad', '{'), /invalid JSON/],
  ['배열 인자', call('bad', '[]'), /JSON object/],
  ['null 인자', call('bad', 'null'), /JSON object/],
  ['미등록 도구', [...call('valid'), ...call('bad', '{}', 'missing')], /no executor/],
  ['미완료 호출', call().slice(0, 2), /incomplete/],
  ['중복 호출 ID', [...call(), ...call()], /duplicate tool call/],
  ['종료 후 인자', [...call(), { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call-1', delta: 'x' }], /not open/]
] as const) {
  test(`${label} 조건에서는 도구를 실행하지 않고 실패 상태로 보존한다`, async (t) => {
    let executions = 0
    const { ctx, requests } = await setup(t, [events], {
      tools: [
        tool(() => {
          executions++
          return 'result'
        })
      ]
    })
    await expect(collect(ctx.agent.run(input))).rejects.toThrow(error)
    expect(executions).toBe(0)
    expect(requests).toHaveLength(1)
    expect((await ctx.generation.get('run'))?.status).toBe('failed')
    await ctx.generation.recover()
    expect(executions).toBe(0)
    expect(requests).toHaveLength(1)
  })
}

test('호출 종료 이후 공급자 스트림이 실패해도 도구를 실행하지 않는다', async (t) => {
  let executions = 0
  const { ctx } = await setup(
    t,
    [],
    {
      tools: [
        tool(() => {
          executions++
          return 'result'
        })
      ]
    },
    {
      stream: async function* () {
        yield* call()
        throw new Error('provider failed')
      }
    }
  )
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('provider failed')
  expect(executions).toBe(0)
})

test('도구가 실패하면 이전 결과를 보존하고 재실행이나 후속 생성을 하지 않는다', async (t) => {
  const executions: string[] = []
  const failure = new Error('tool failed')
  const { ctx, requests } = await setup(t, [[...call('first'), ...call('second'), ...call('third')]], {
    tools: [
      tool((_args, context) => {
        executions.push(context.toolCallId)
        if (context.toolCallId === 'second') throw failure
        return 'saved result'
      })
    ]
  })
  await expect(collect(ctx.agent.run(input))).rejects.toBe(failure)
  expect(executions).toEqual(['first', 'second'])
  const run = await ctx.generation.get('run')
  expect(run?.status).toBe('failed')
  expect(run?.messages).toContainEqual({
    id: expect.any(String),
    role: 'tool',
    toolCallId: 'first',
    content: 'saved result'
  })
  expect(run?.journal.some(({ event }) => event.type === EventType.RUN_FINISHED)).toBe(false)
  await ctx.generation.recover()
  expect(executions).toEqual(['first', 'second'])
  expect(requests).toHaveLength(1)
})

test('반복 한도까지 결과를 전달한 뒤 추가 도구 호출은 실행하지 않는다', async (t) => {
  let executions = 0
  const { ctx, requests } = await setup(t, [call('first'), call('second')], {
    maxToolRounds: 1,
    tools: [
      tool(() => {
        executions++
        return 'result'
      })
    ]
  })
  await expect(collect(ctx.agent.run(input))).rejects.toThrow(/maximum tool rounds/)
  expect(executions).toBe(1)
  expect(requests).toHaveLength(2)
  expect((await ctx.generation.get('run'))?.status).toBe('failed')
})

for (const mode of ['external', 'return', 'dispose'] as const) {
  test(`${mode} 취소는 실행 중인 도구에 전달되며 후속 생성을 막는다`, async (t) => {
    const entered = Promise.withResolvers<AbortSignal>()
    const { ctx, requests, agent } = await setup(t, [call()], {
      tools: [
        tool(
          (_args, { signal }) =>
            new Promise<string>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true })
              entered.resolve(signal)
            })
        )
      ]
    })
    const external = new globalThis.AbortController()
    const iterator = ctx.agent.run(input, { signal: external.signal })
    const pending = collect(iterator)
    const rejected = expect(pending).rejects.toThrow()
    const signal = await entered.promise
    if (mode === 'external') external.abort(new Error('cancelled'))
    else if (mode === 'return') await iterator.return!()
    else await agent.dispose()
    await rejected
    expect(signal.aborted).toBe(true)
    expect(requests).toHaveLength(1)
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
    expect((await ctx.generation.get('run'))?.status).not.toBe('completed')
  })
}

test('결과 이벤트에서 순회를 중단하면 결과를 남기고 후속 생성을 시작하지 않는다', async (t) => {
  const { ctx, requests } = await setup(t, [call()])
  for await (const event of ctx.agent.run(input)) {
    if (event.type === EventType.TOOL_CALL_RESULT) break
  }
  expect(requests).toHaveLength(1)
  const run = await ctx.generation.get('run')
  expect(run?.messages.at(-1)).toMatchObject({ role: 'tool', content: 'result' })
  expect(run?.status).not.toBe('completed')
  await ctx.generation.recover()
  expect(requests).toHaveLength(1)
})

test('도구 결과로 입력 예산을 초과하면 초과한 후속 요청을 보내지 않는다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    [call()],
    {},
    {
      countTokens: async (request) => (request.input.messages.some((message) => message.role === 'tool') ? 2001 : 10)
    }
  )
  await expect(collect(ctx.agent.run(input))).rejects.toThrow(/no older conversation/)
  expect(requests).toHaveLength(1)
  expect((await ctx.generation.get('run'))?.status).toBe('failed')
})

test('후속 입력을 축약할 때 현재 도구 호출과 결과를 함께 보존한다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    [
      call(),
      [
        { type: EventType.TEXT_MESSAGE_START, messageId: 'summary', role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'summary', delta: 'earlier facts' },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'summary' }
      ],
      answer
    ],
    {
      compaction: { keepRecentMessages: 1, maxSummaryTokens: 100 }
    },
    {
      countTokens: async (request) =>
        request.input.messages.some((message) => message.id === 'old') &&
        request.input.messages.some((message) => message.role === 'tool')
          ? 2001
          : 10
    }
  )
  await collect(
    ctx.agent.run({ ...input, messages: [{ id: 'old', role: 'user', content: 'older history' }, ...input.messages] })
  )
  expect(requests).toHaveLength(3)
  expect(requests[1].input.tools).toEqual([])
  expect(requests[2].input.messages.some((message) => message.id === 'old')).toBe(false)
  expect(requests[2].input.messages.slice(-3)).toEqual([
    ...input.messages,
    {
      id: 'call-1',
      role: 'assistant',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"value":1}' } }]
    },
    { id: expect.any(String), role: 'tool', toolCallId: 'call-1', content: 'result' }
  ])
})

test('요청과 설정에 같은 도구를 정의하면 생성을 시작하기 전에 거부한다', async (t) => {
  const { ctx, requests } = await setup(t, [])
  await expect(
    collect(ctx.agent.run({ ...input, tools: [{ name: 'lookup', description: '', parameters: {} }] }))
  ).rejects.toThrow(/both input and agent config/)
  expect(requests).toHaveLength(0)
})

test('설정은 실행 함수를 보존하고 중복 도구와 잘못된 반복 한도를 거부한다', async () => {
  const execute = () => 'ok'
  const valid = await SimpleAgentConfigSchema['~standard'].validate({
    model: 'test',
    maxOutputTokens: 10,
    tools: [tool(execute)]
  })
  expect(valid.issues).toBeUndefined()
  if (!valid.issues) expect(valid.value.tools?.[0].execute).toBe(execute)
  for (const invalid of [
    { tools: [tool(), tool()] },
    { tools: [{ ...tool(), execute: null }] },
    { maxToolRounds: 0 },
    { maxToolRounds: 1.5 }
  ]) {
    const result = await SimpleAgentConfigSchema['~standard'].validate({
      model: 'test',
      maxOutputTokens: 10,
      ...invalid
    })
    expect(result.issues?.length).toBeGreaterThan(0)
  }
})
