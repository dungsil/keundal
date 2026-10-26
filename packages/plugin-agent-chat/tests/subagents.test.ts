import { AgentConfigSchema, type AgentConfig } from '@keundal/agent-loop'
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
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import type { ExecutableTool } from '@keundal/tools'
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
  config: Partial<AgentConfig> = {},
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
  const agent = await ctx.plugin(agentPlugin, {
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

test('서브에이전트는 독립된 대화에서 도구를 실행하고 최종 답변만 부모에게 돌려준다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    [call('delegate', JSON.stringify({ task: 'inspect' }), 'delegate_task'), call('child-lookup'), answer, answer],
    {
      subagents: true,
      subagentRoles: [{ name: 'reviewer', description: 'Review changes', instructions: 'Check correctness.' }]
    }
  )
  const events = await collect(ctx.agent.run(input))
  expect(requests).toHaveLength(4)
  const child = requests[1].input
  expect(child.threadId).not.toBe(input.threadId)
  expect(child.runId).not.toBe(input.runId)
  expect(child.messages).toEqual([{ id: expect.any(String), role: 'user', content: 'inspect' }])
  expect(child.context).toEqual([])
  expect(child.tools.map((tool) => tool.name)).toEqual(['lookup'])
  expect(child.state).toEqual({ subagent: { parentThreadId: 'thread', parentRunId: 'run', toolCallId: 'delegate' } })
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
  expect(result?.type).toBe(EventType.TOOL_CALL_RESULT)
  if (result?.type !== EventType.TOOL_CALL_RESULT) throw new Error('missing result')
  expect(JSON.parse(result.content as string)).toEqual({
    status: 'completed',
    threadId: child.threadId,
    runId: child.runId,
    content: 'done'
  })
  expect(events.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1)
  expect(events.some((event) => event.type === EventType.TOOL_CALL_START && event.toolCallId === 'child-lookup')).toBe(
    false
  )
  const parentSession = await ctx.session.get(input.threadId)
  const childSession = await ctx.session.get(child.threadId)
  expect(parentSession?.messages.some((message) => message.role === 'user' && message.content === 'inspect')).toBe(
    false
  )
  expect(childSession?.messages.some((message) => message.role === 'tool' && message.content === 'result')).toBe(true)
  expect((await ctx.generation.get(child.runId))?.status).toBe('completed')
})

test('설정을 생략하면 위임 도구를 등록하지 않는다', async (t) => {
  const { ctx, requests } = await setup(t, [answer])
  await collect(ctx.agent.run(input))
  expect(requests[0].input.tools.map((tool) => tool.name)).toEqual(['lookup'])
})

test.for(['config', 'request'] as const)(
  '역할을 %s에 정의하면 선택한 역할 지침만 독립된 서브에이전트에 전달한다',
  async (source, t) => {
    const roles = [
      { name: 'researcher', description: 'Find relevant facts', instructions: 'Gather sources, do not review code.' },
      { name: 'reviewer', description: 'Review changes', instructions: 'Report correctness risks and missing tests.' }
    ]
    const { ctx, requests } = await setup(
      t,
      [
        call('delegate', JSON.stringify({ task: 'inspect the diff', role: 'reviewer' }), 'delegate_task'),
        answer,
        answer
      ],
      { subagents: true, ...(source === 'config' ? { subagentRoles: roles } : {}) }
    )
    await collect(ctx.agent.run({ ...input, state: source === 'request' ? { subagentRoles: roles } : input.state }))
    const definition = requests[0].input.tools.find((tool) => tool.name === 'delegate_task')!
    expect(definition.description).toContain('Review changes')
    expect(definition.description).not.toContain(roles[1].instructions)
    expect(definition.parameters).toMatchObject({ properties: { role: { enum: ['researcher', 'reviewer'] } } })
    expect(requests[0].input.messages).not.toContainEqual(expect.objectContaining({ content: roles[1].instructions }))
    const child = requests[1].input
    expect(child.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'system', content: roles[1].instructions },
      { role: 'user', content: 'inspect the diff' }
    ])
    expect(child.context).toEqual([])
    expect(child.tools.map((tool) => tool.name)).toEqual(['lookup'])
    expect(child.state).toMatchObject({ subagent: { role: 'reviewer', label: 'reviewer' } })
    expect(child.state).not.toHaveProperty('subagentRoles')
  }
)

test('다음 요청의 역할 변경과 삭제는 이전 세션이나 설정의 역할을 남기지 않는다', async (t) => {
  const roles = [{ name: 'reviewer', description: 'Review changes', instructions: 'Review carefully.' }]
  const replies = ['first', 'second', 'third'].map((messageId) =>
    answer.map((event) => ('messageId' in event ? { ...event, messageId } : event))
  )
  const { ctx, requests } = await setup(t, replies, { subagents: true, subagentRoles: roles })
  await collect(ctx.agent.run(input))
  await collect(
    ctx.agent.run({ ...input, runId: 'changed', state: { subagentRoles: [{ ...roles[0], name: 'writer' }] } })
  )
  await collect(ctx.agent.run({ ...input, runId: 'cleared', state: { subagentRoles: [] } }))
  const definitions = requests.map((request) => request.input.tools.find((tool) => tool.name === 'delegate_task')!)
  expect(definitions[0].parameters).toMatchObject({ properties: { role: { enum: ['reviewer'] } } })
  expect(definitions[1].parameters).toMatchObject({ properties: { role: { enum: ['writer'] } } })
  expect(definitions[2].parameters.properties).not.toHaveProperty('role')
  expect(definitions[2].description).not.toContain('Review changes')
})

test('등록하지 않은 역할은 서브에이전트를 시작하지 않는다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    [call('delegate', JSON.stringify({ task: 'inspect', role: 'missing' }), 'delegate_task')],
    {
      subagents: true,
      subagentRoles: [{ name: 'reviewer', description: 'Review changes', instructions: 'Review carefully.' }]
    }
  )
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('delegate_task role must name a configured role')
  expect(requests).toHaveLength(1)
})

test.for([{}, { task: '' }, { task: '  ' }, { task: 1 }, { task: 'inspect', extra: true }])(
  '잘못된 위임 인자 %j는 자식 실행을 시작하지 않는다',
  async (args, t) => {
    const { ctx, requests } = await setup(t, [call('delegate', JSON.stringify(args), 'delegate_task')], {
      subagents: true
    })
    await expect(collect(ctx.agent.run(input))).rejects.toThrow('delegate_task requires')
    expect(requests).toHaveLength(1)
  }
)

test('서브에이전트가 다시 위임하려 하면 실행을 거부한다', async (t) => {
  const delegate = call('delegate', JSON.stringify({ task: 'inspect' }), 'delegate_task')
  const { ctx, requests } = await setup(t, [delegate, delegate, answer], { subagents: true })
  const events = await collect(ctx.agent.run(input))
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
  expect(result?.type === EventType.TOOL_CALL_RESULT && JSON.parse(result.content as string)).toMatchObject({
    status: 'failed',
    error: { code: 'EXECUTION_FAILED' }
  })
  expect(requests).toHaveLength(3)
  expect((await ctx.generation.get(requests[1].input.runId))?.status).toBe('failed')
})

test('부모 취소는 실행 중인 서브에이전트에 전달된다', async (t) => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let childSignal: AbortSignal | undefined
  const { ctx, requests } = await setup(
    t,
    [],
    { subagents: true },
    {
      async *stream(request, options) {
        if (request.input.threadId === input.threadId) {
          yield* call('delegate', JSON.stringify({ task: 'inspect' }), 'delegate_task')
        } else {
          childSignal = options?.signal
          started()
          await new Promise<void>((_, reject) => {
            childSignal!.addEventListener('abort', () => reject(childSignal!.reason), { once: true })
          })
        }
      }
    }
  )
  const controller = new AbortController()
  const pending = collect(ctx.agent.run(input, { signal: controller.signal }))
  const rejected = expect(pending).rejects.toThrow('cancel parent')
  await ready
  controller.abort(new Error('cancel parent'))
  await rejected
  expect(childSignal?.aborted).toBe(true)
  expect((await ctx.generation.get(requests[1].input.runId))?.status).toBe('cancelled')
})

test('병렬 위임은 자식별로 독립된 실행을 만들고 결과를 호출 순서로 반환한다', async (t) => {
  let started = 0
  let release!: () => void
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve
  })
  const { ctx, requests } = await setup(
    t,
    [],
    { subagents: true, parallelTools: true },
    {
      async *stream(request) {
        if (request.input.threadId === input.threadId) {
          if (request.input.messages.some((message) => message.role === 'tool')) yield* answer
          else {
            yield* call('first', JSON.stringify({ task: 'first' }), 'delegate_task')
            yield* call('second', JSON.stringify({ task: 'second' }), 'delegate_task')
          }
        } else {
          if (++started === 2) release()
          await bothStarted
          yield* answer
        }
      }
    }
  )
  const events = await collect(ctx.agent.run(input))
  expect(new Set(requests.slice(1, 3).map((request) => request.input.threadId)).size).toBe(2)
  expect(events.filter((event) => event.type === EventType.TOOL_CALL_RESULT).map((event) => event.toolCallId)).toEqual([
    'first',
    'second'
  ])
})

test('서브에이전트 설정의 타입과 예약 도구 이름을 검증한다', async () => {
  const validate = AgentConfigSchema['~standard'].validate
  expect(await validate({ model: 'test', maxOutputTokens: 100, subagents: 'yes' })).toHaveProperty('issues')
  expect(
    await validate({
      model: 'test',
      maxOutputTokens: 100,
      subagents: true,
      tools: [{ ...tool(), name: 'delegate_task' }]
    })
  ).toHaveProperty('issues')
})

test('동적으로 제공한 도구도 예약된 위임 이름을 사용할 수 없다', async (t) => {
  const { ctx, requests } = await setup(t, [], { subagents: true, tools: () => [{ ...tool(), name: 'delegate_task' }] })
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('delegate_task tool name is reserved')
  expect(requests).toHaveLength(0)
})

test('앞선 위임이 실행 중이어도 뒤의 위임 완료 상태를 즉시 전달한다', async (t) => {
  let release!: () => void
  const firstWaiting = new Promise<void>((resolve) => {
    release = resolve
  })
  t.onTestFinished(release)
  const { ctx } = await setup(
    t,
    [],
    { subagents: true, parallelTools: true },
    {
      async *stream(request) {
        if (request.input.threadId === input.threadId) {
          if (request.input.messages.some((message) => message.role === 'tool')) yield* answer
          else {
            yield* call('first', JSON.stringify({ task: 'first' }), 'delegate_task')
            yield* call('second', JSON.stringify({ task: 'second' }), 'delegate_task')
          }
        } else {
          if (request.input.messages[0].content === 'first') await firstWaiting
          yield* answer
        }
      }
    }
  )
  const events: AGUIEvent[] = []
  for await (const event of ctx.agent.run(input)) {
    events.push(event)
    if (
      event.type === EventType.CUSTOM &&
      event.name === 'keundal.tool.progress' &&
      event.value.toolCallId === 'second' &&
      event.value.value.status === 'completed'
    ) {
      expect(events.some((entry) => entry.type === EventType.TOOL_CALL_RESULT)).toBe(false)
      release()
    }
  }
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
})

test('동시 실행 한도를 넘으면 시작 전에 거절하고 완료 후에는 자리를 재사용한다', async (t) => {
  const delegate = (id: string) => call(id, JSON.stringify({ task: id }), 'delegate_task')
  const { ctx, requests } = await setup(
    t,
    [[...delegate('first'), ...delegate('second')], answer, delegate('retry'), answer, answer],
    { subagents: true, parallelTools: true, maxActiveSubagents: 1 }
  )
  const events = await collect(ctx.agent.run(input))
  const results = events
    .filter((event) => event.type === EventType.TOOL_CALL_RESULT)
    .map((event) => JSON.parse(event.content as string))
  expect(results.map((result) => result.status)).toEqual(['completed', 'rejected', 'completed'])
  expect(results[1]).toMatchObject({ error: { code: 'ACTIVE_LIMIT_REACHED' } })
  expect(results[1]).not.toHaveProperty('threadId')
  expect(requests.filter((request) => request.input.threadId !== input.threadId)).toHaveLength(2)
})

test('실패한 자식의 부분 응답과 오류를 반환하고 형제와 부모는 계속 실행한다', async (t) => {
  const { ctx } = await setup(
    t,
    [],
    { subagents: true, parallelTools: true },
    {
      async *stream(request) {
        if (request.input.threadId === input.threadId) {
          if (request.input.messages.some((message) => message.role === 'tool')) yield* answer
          else {
            yield* call('bad', JSON.stringify({ task: 'fail' }), 'delegate_task')
            yield* call('good', JSON.stringify({ task: 'succeed' }), 'delegate_task')
          }
        } else {
          yield* answer
          if (request.input.messages[0].content === 'fail') throw new Error('child unavailable')
        }
      }
    }
  )
  const events = await collect(ctx.agent.run(input))
  const results = events
    .filter((event) => event.type === EventType.TOOL_CALL_RESULT)
    .map((event) => JSON.parse(event.content as string))
  expect(results[0]).toMatchObject({
    status: 'failed',
    content: 'done',
    error: { code: 'EXECUTION_FAILED', message: 'child unavailable' }
  })
  expect(results[1]).toMatchObject({ status: 'completed', content: 'done' })
  expect((await ctx.generation.get(results[0].runId))?.status).toBe('failed')
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
})

test('마지막 빈 메시지가 앞선 답변을 지우지 않고 작업 이름을 기록한다', async (t) => {
  const { ctx, requests } = await setup(
    t,
    [
      call('delegate', JSON.stringify({ task: 'inspect', label: 'Review' }), 'delegate_task'),
      [
        ...answer,
        { type: EventType.TEXT_MESSAGE_START, messageId: 'empty', role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'empty' }
      ],
      answer
    ],
    { subagents: true }
  )
  const events = await collect(ctx.agent.run(input))
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT)
  expect(result?.type === EventType.TOOL_CALL_RESULT && JSON.parse(result.content as string)).toMatchObject({
    status: 'completed',
    content: 'done'
  })
  expect(requests[1].input.state).toMatchObject({ subagent: { label: 'Review' } })
  expect(events).toContainEqual(
    expect.objectContaining({
      type: EventType.CUSTOM,
      value: expect.objectContaining({ value: expect.objectContaining({ label: 'Review', status: 'completed' }) })
    })
  )
})

test.for([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '8', null])(
  '잘못된 동시 실행 한도 %j를 거부한다',
  async (maxActiveSubagents) => {
    expect(
      await AgentConfigSchema['~standard'].validate({ model: 'test', maxOutputTokens: 100, maxActiveSubagents })
    ).toHaveProperty('issues')
  }
)

test.for(['', ' '.repeat(2), 'x'.repeat(81), 1])('잘못된 작업 이름 %j는 자식을 실행하지 않는다', async (label, t) => {
  const { ctx, requests } = await setup(
    t,
    [call('delegate', JSON.stringify({ task: 'inspect', label }), 'delegate_task')],
    { subagents: true }
  )
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('delegate_task label')
  expect(requests).toHaveLength(1)
})
