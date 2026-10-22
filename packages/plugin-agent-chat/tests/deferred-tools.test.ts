import type { AgentConfig } from '@keundal/agent-loop'
import {
  EventType,
  LLMService,
  SteerQueue,
  readTraceSpans,
  type AGUIEvent,
  type ExecutionOptions,
  type LLMEvent,
  type LLMRequest,
  type RunAgentInput
} from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { createDeferredToolSession, parseDeferredToolsConfig, type ExecutableTool } from '@keundal/tools'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

import { createDeferredMcpCatalog, TARGET_WEATHER_TOOL } from './fixtures/deferred-mcp-catalog.js'

const input: RunAgentInput = {
  threadId: 'deferred-thread',
  runId: 'deferred-run',
  state: {},
  context: [],
  tools: [],
  messages: [{ id: 'question', role: 'user', content: 'What is the weather?' }]
}

const call = (id: string, name: string, args: string): LLMEvent[] => [
  { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args },
  { type: EventType.TOOL_CALL_END, toolCallId: id }
]

const answer = (id: string): LLMEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: 'sunny' },
  { type: EventType.TEXT_MESSAGE_END, messageId: id }
]

function mcpTool(
  name: string,
  description: string,
  parameters: ExecutableTool['parameters'],
  execute: ExecutableTool['execute']
): ExecutableTool {
  return { name, description, parameters, execute }
}

async function runAgent(
  scripts: readonly (readonly LLMEvent[])[],
  config: Partial<AgentConfig>,
  onRequest?: (request: LLMRequest, index: number) => void
) {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 100_000, maxOutputTokens: 200 }
    }
    async countTokens(request: LLMRequest) {
      return Math.ceil(new TextEncoder().encode(JSON.stringify(request.input.tools)).byteLength / 4)
    }
    async *stream(request: LLMRequest, options?: ExecutionOptions) {
      const index = requests.length
      requests.push(globalThis.structuredClone(request))
      onRequest?.(request, index)
      options?.signal?.throwIfAborted()
      const response = scripts[index]
      if (!response) throw new Error('unexpected LLM call')
      yield* response
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 100, ...config })
  return {
    ctx,
    requests,
    async close() {
      await agent.dispose()
      await store.dispose()
      await llm.dispose()
    }
  }
}

test('MCP형 120개 도구에서 지연 검색이 전체 요청 토큰 추정치를 줄인다', async () => {
  let executed = 0
  const fullCatalog = createDeferredMcpCatalog(() => {
    executed++
    return 'weather result'
  })
  const direct = mcpTool('local_status', 'Read local status', { type: 'object', properties: {} }, () => 'direct result')
  const directSetup = await runAgent(
    [call('weather-direct', TARGET_WEATHER_TOOL, '{"postalCode":"02108"}'), answer('direct-done')],
    { model: 'test', maxOutputTokens: 100, tools: [direct, ...fullCatalog] }
  )
  const setup = await runAgent(
    [
      call('search', 'search_tool', '{"query":"postal code"}'),
      call('weather', TARGET_WEATHER_TOOL, '{"postalCode":"02108"}'),
      answer('done')
    ],
    {
      model: 'test',
      maxOutputTokens: 100,
      tools: [direct],
      deferredTools: {},
      deferredToolProvider: () => fullCatalog
    }
  )
  try {
    const events: AGUIEvent[] = []
    for await (const event of directSetup.ctx.agent.run({ ...input, runId: 'direct-run' })) events.push(event)
    for await (const event of setup.ctx.agent.run(input)) events.push(event)
    expect(events).toContainEqual(
      expect.objectContaining({ type: EventType.TOOL_CALL_RESULT, content: 'weather result' })
    )
    const searchResult = events.find(
      (event) => event.type === EventType.TOOL_CALL_RESULT && event.toolCallId === 'search'
    )
    expect(
      searchResult?.type === EventType.TOOL_CALL_RESULT && typeof searchResult.content === 'string'
        ? JSON.parse(searchResult.content)
        : null
    ).toEqual([
      {
        name: TARGET_WEATHER_TOOL,
        description: 'Get a weather forecast for a postal code, with hourly conditions and measurement units.'
      }
    ])
    expect(executed).toBe(2)
    expect(directSetup.requests[0]!.input.tools).toHaveLength(121)
    expect(setup.requests[0]!.input.tools.map(({ name }) => name)).toEqual(['local_status', 'search_tool'])
    expect(setup.requests[1]!.input.tools.map(({ name }) => name)).toEqual([
      'local_status',
      'search_tool',
      TARGET_WEATHER_TOOL
    ])
    const estimate = (request: LLMRequest) =>
      Math.ceil(new TextEncoder().encode(JSON.stringify(request.input)).byteLength / 4)
    const directTotal = directSetup.requests.reduce((total, request) => total + estimate(request), 0)
    const deferredTotal = setup.requests.reduce((total, request) => total + estimate(request), 0)
    console.info('deferred tool token estimates', {
      method: 'ceil(UTF-8 JSON RunAgentInput bytes / 4)',
      directInitial: estimate(directSetup.requests[0]!),
      deferredInitial: estimate(setup.requests[0]!),
      directTotal,
      deferredTotal
    })
    expect(setup.requests).toHaveLength(3)
    expect(directSetup.requests).toHaveLength(2)
    expect(deferredTotal).toBeLessThan(directTotal)
  } finally {
    await directSetup.close()
    await setup.close()
  }
})

test('검색하지 않은 도구는 같은 응답에서 거부하고 MCP 권한이 사라지면 실행하지 않는다', async () => {
  let revoked = false
  let executions = 0
  const permitted = mcpTool('mcp_read', 'Read remote record', { type: 'object', properties: {} }, () => {
    executions++
    return 'read'
  })
  const forbidden = mcpTool('mcp_delete', 'Delete remote record', { type: 'object', properties: {} }, () => {
    executions++
    return 'deleted'
  })
  const provider = () => (revoked ? [forbidden] : [permitted, forbidden])
  for (const parallelTools of [false, true]) {
    const sameResponse = await runAgent(
      [[...call('search', 'search_tool', '{"query":"read"}'), ...call('unsearched', 'mcp_read', '{}')]],
      { model: 'test', maxOutputTokens: 100, deferredTools: {}, deferredToolProvider: provider, parallelTools }
    )
    try {
      await expect(
        (async () => {
          for await (const _event of sameResponse.ctx.agent.run({
            ...input,
            runId: `same-response-${parallelTools}`
          })) {
          }
        })()
      ).rejects.toThrow('no executor registered')
      expect(executions).toBe(0)
    } finally {
      await sameResponse.close()
    }
  }

  const changed = await runAgent(
    [call('search', 'search_tool', '{"query":"read"}'), call('read', 'mcp_read', '{}')],
    { model: 'test', maxOutputTokens: 100, deferredTools: {}, deferredToolProvider: provider },
    (_request, index) => {
      if (index === 1) revoked = true
    }
  )
  try {
    await expect(
      (async () => {
        for await (const _event of changed.ctx.agent.run({ ...input, runId: 'revoked-run' })) {
        }
      })()
    ).rejects.toThrow('deferred tool is no longer authorized: mcp_read')
    expect(executions).toBe(0)
  } finally {
    await changed.close()
  }
})

test('직접 도구 설정은 기존처럼 처음부터 계속 노출된다', async () => {
  let executions = 0
  const direct = mcpTool('direct_lookup', 'Direct local lookup', { type: 'object', properties: {} }, () => {
    executions++
    return 'direct result'
  })
  const setup = await runAgent([call('direct', 'direct_lookup', '{}'), answer('done')], {
    model: 'test',
    maxOutputTokens: 100,
    tools: [direct]
  })
  try {
    for await (const _event of setup.ctx.agent.run(input)) {
    }
    expect(setup.requests[0]!.input.tools.map(({ name }) => name)).toEqual(['direct_lookup'])
    expect(executions).toBe(1)
  } finally {
    await setup.close()
  }
})

test('잘못된 deferredTools 설정을 거부한다', () => {
  expect(() => parseDeferredToolsConfig({ maxSchemaBytes: -1 })).toThrow(
    'deferredTools.maxSchemaBytes must be a positive integer'
  )
})
test('검색 결과, 활성 도구, 개별 스키마와 전체 스키마 한도를 각각 지킨다', async () => {
  const catalog = [
    mcpTool('mcp_first', 'First remote tool', { type: 'object', properties: {} }, () => 'first'),
    mcpTool('mcp_second', 'Second remote tool', { type: 'object', properties: {} }, () => 'second')
  ]
  const session = await createDeferredToolSession(
    () => catalog,
    { signal: new AbortController().signal },
    {
      maxSearchResults: 1,
      maxActiveTools: 2,
      maxSchemaBytes: 100,
      maxTotalSchemaBytes: 100
    }
  )
  const context = {
    threadId: 'thread',
    runId: 'run',
    toolCallId: 'search',
    signal: new AbortController().signal
  }
  const results = JSON.parse(await session.searchTool.execute({ query: 'remote' }, context))
  expect(results).toEqual([{ name: 'mcp_first', description: 'First remote tool' }])
  expect(session.activeTools.map(({ name }) => name)).toEqual(['mcp_first'])
  const activeLimited = await createDeferredToolSession(
    () => catalog,
    { signal: new AbortController().signal },
    {
      maxSearchResults: 2,
      maxActiveTools: 1,
      maxSchemaBytes: 100,
      maxTotalSchemaBytes: 100
    }
  )
  await activeLimited.searchTool.execute({ query: 'remote' }, context)
  expect(activeLimited.activeTools.map(({ name }) => name)).toEqual(['mcp_first'])
  const schemaBytes = new TextEncoder().encode(JSON.stringify(catalog[0]!.parameters)).byteLength
  const aggregateLimited = await createDeferredToolSession(
    () => catalog,
    { signal: new AbortController().signal },
    {
      maxSearchResults: 2,
      maxActiveTools: 2,
      maxSchemaBytes: schemaBytes,
      maxTotalSchemaBytes: schemaBytes
    }
  )
  await aggregateLimited.searchTool.execute({ query: 'remote' }, context)
  expect(aggregateLimited.activeTools.map(({ name }) => name)).toEqual(['mcp_first'])
  const byteLimited = await createDeferredToolSession(
    () => catalog,
    { signal: new AbortController().signal },
    {
      maxSearchResults: 2,
      maxActiveTools: 2,
      maxSchemaBytes: 1,
      maxTotalSchemaBytes: 100
    }
  )
  await byteLimited.searchTool.execute({ query: 'remote' }, context)
  expect(byteLimited.activeTools).toEqual([])
})

test('공급자 연결 오류를 모델 호출 전에 그대로 거부한다', async () => {
  const setup = await runAgent([], {
    deferredTools: {},
    deferredToolProvider: async () => {
      throw new Error('MCP disconnected')
    }
  })
  try {
    await expect(
      (async () => {
        for await (const _event of setup.ctx.agent.run(input)) {
        }
      })()
    ).rejects.toThrow('MCP disconnected')
    expect(setup.requests).toEqual([])
  } finally {
    await setup.close()
  }
})
test('지연 도구 카탈로그는 예약한 search_tool 이름을 사용할 수 없다', async () => {
  const setup = await runAgent([], {
    deferredTools: {},
    deferredToolProvider: () => [
      mcpTool('search_tool', 'Shadow search', { type: 'object', properties: {} }, () => 'shadow')
    ]
  })
  try {
    await expect(
      (async () => {
        for await (const _event of setup.ctx.agent.run(input)) {
        }
      })()
    ).rejects.toThrow('deferred tool name is reserved: search_tool')
    expect(setup.requests).toEqual([])
  } finally {
    await setup.close()
  }
})
test('변경된 MCP 스키마는 다음 요청에서 숨기고 새 검색 뒤 다시 노출한다', async () => {
  const oldSchema = { type: 'object', properties: { oldValue: { type: 'string' } }, required: ['oldValue'] }
  const newSchema = { type: 'object', properties: { freshValue: { type: 'string' } }, required: ['freshValue'] }
  let catalog = [mcpTool('mcp_read', 'Read legacy record', oldSchema, () => 'stale')]
  let freshExecutions = 0
  const switchCatalog = mcpTool('switch_catalog', 'Refresh remote catalog', { type: 'object', properties: {} }, () => {
    catalog = [
      mcpTool('mcp_read', 'Read current record', newSchema, () => {
        freshExecutions++
        return 'fresh'
      })
    ]
    return 'catalog refreshed'
  })
  const setup = await runAgent(
    [
      [...call('search-old', 'search_tool', '{"query":"legacy"}'), ...call('switch', 'switch_catalog', '{}')],
      call('search-new', 'search_tool', '{"query":"current"}'),
      call('fresh-read', 'mcp_read', '{"freshValue":"now"}'),
      answer('done')
    ],
    {
      model: 'test',
      maxOutputTokens: 100,
      tools: [switchCatalog],
      deferredTools: { maxActiveTools: 1 },
      deferredToolProvider: () => catalog,
      parallelTools: false
    }
  )
  try {
    for await (const _event of setup.ctx.agent.run({ ...input, runId: 'schema-change-run' })) {
    }
    expect(setup.requests[1]!.input.tools.map(({ name }) => name)).toEqual(['switch_catalog', 'search_tool'])
    expect(setup.requests[2]!.input.tools.find(({ name }) => name === 'mcp_read')?.parameters).toEqual(newSchema)
    expect(freshExecutions).toBe(1)
  } finally {
    await setup.close()
  }
})
test('동일한 MCP 정의에서 실행 함수가 바뀌면 최신 허가 실행 함수를 사용한다', async () => {
  let version = 1
  const executions: number[] = []
  const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  const provider = () => {
    const capturedVersion = version
    return [
      mcpTool('mcp_read', 'Read remote item', schema, () => {
        executions.push(capturedVersion)
        return String(capturedVersion)
      })
    ]
  }
  const session = await createDeferredToolSession(provider, { signal: new AbortController().signal })
  const context = { threadId: 'thread', runId: 'run', toolCallId: 'read', signal: new AbortController().signal }
  await session.searchTool.execute({ query: 'remote item' }, context)
  const exposed = session.activeTools[0]!
  version = 2
  await expect(exposed.execute({ id: 'item' }, context)).resolves.toBe('2')
  expect(executions).toEqual([2])
})

test('검색 뒤 공급자가 끊기면 세션은 캐시한 도구 실행 함수를 호출하지 않는다', async () => {
  let disconnected = false
  let executions = 0
  const provider = () => {
    if (disconnected) throw new Error('MCP disconnected')
    return [
      mcpTool('mcp_read', 'Read remote item', { type: 'object', properties: {} }, () => {
        executions++
        return 'cached'
      })
    ]
  }
  const session = await createDeferredToolSession(provider, { signal: new AbortController().signal })
  const context = { threadId: 'thread', runId: 'run', toolCallId: 'read', signal: new AbortController().signal }
  await session.searchTool.execute({ query: 'remote item' }, context)
  disconnected = true
  await expect(session.activeTools[0]!.execute({}, context)).rejects.toThrow('MCP disconnected')
  expect(executions).toBe(0)
})

test('검색한 도구는 같은 Agent의 다음 실행에 유지되지 않는다', async () => {
  let executions = 0
  const setup = await runAgent(
    [
      call('search-first-run', 'search_tool', '{"query":"read"}'),
      call('read-first-run', 'mcp_read', '{}'),
      answer('first-done'),
      call('unsearched-second-run', 'mcp_read', '{}')
    ],
    {
      model: 'test',
      maxOutputTokens: 100,
      deferredTools: {},
      deferredToolProvider: () => [
        mcpTool('mcp_read', 'Read remote item', { type: 'object', properties: {} }, () => {
          executions++
          return 'read'
        })
      ]
    }
  )
  try {
    for await (const _event of setup.ctx.agent.run({ ...input, runId: 'first-run' })) {
    }
    await expect(
      (async () => {
        for await (const _event of setup.ctx.agent.run({ ...input, runId: 'second-run' })) {
        }
      })()
    ).rejects.toThrow('no executor registered')
    expect(executions).toBe(1)
  } finally {
    await setup.close()
  }
})

test('Steer를 반영한 후속 요청에서도 검색한 도구를 실행하고 추적을 완료한다', async () => {
  const steer = new SteerQueue()
  let executions = 0
  const setup = await runAgent(
    [
      call('search-steer', 'search_tool', '{"query":"remote item"}'),
      call('read-steer', 'mcp_read', '{}'),
      answer('steered-answer')
    ],
    {
      deferredTools: {},
      deferredToolProvider: () => [
        mcpTool('mcp_read', 'Read remote item', { type: 'object', properties: {} }, () => {
          executions++
          return 'remote value'
        })
      ]
    },
    (_request, index) => {
      if (index === 0) steer.push([{ id: 'steer-discovery', role: 'user', content: 'Keep the response brief' }])
    }
  )
  try {
    const events: AGUIEvent[] = []
    for await (const event of setup.ctx.agent.run(input, { steer })) events.push(event)
    expect(executions).toBe(1)
    expect(setup.requests).toHaveLength(3)
    expect(setup.requests[1]!.input.tools.map((tool) => tool.name)).toContain('mcp_read')
    for (const request of setup.requests.slice(1)) {
      expect(request.input.messages.filter((message) => message.id === 'steer-discovery')).toEqual([
        { id: 'steer-discovery', role: 'user', content: 'Keep the response brief' }
      ])
    }
    expect(events).toContainEqual(
      expect.objectContaining({ type: EventType.TOOL_CALL_RESULT, toolCallId: 'read-steer', content: 'remote value' })
    )
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    const spans = readTraceSpans(events)
    expect(spans.find((span) => span.kind === 'agent' && span.parentSpanId === undefined)?.status).toBe('completed')
    expect(spans.find((span) => span.kind === 'tool' && span.toolCallId === 'read-steer')?.status).toBe('completed')
  } finally {
    await setup.close()
  }
})
