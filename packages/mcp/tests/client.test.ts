import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import agentPlugin, { type ExecutableTool, type ToolExecutionContext } from '@keundal/agent'
import { EventType, LLMService, type LLMEvent, type LLMRequest } from '@keundal/core'
import { McpClient, type McpPermissions, parseMcpServers } from '@keundal/mcp'
import { McpClient as BrowserMcpClient } from '@keundal/mcp/browser'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { WebStandardStreamableHTTPServerTransport, type ServerCapabilities } from '@modelcontextprotocol/server'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

import { createFixture } from './fixtures/server.ts'

const context = (signal = new AbortController().signal): ToolExecutionContext => ({
  threadId: 'thread',
  runId: 'run',
  toolCallId: 'call',
  signal
})
const execute = async (tools: ExecutableTool[], name: string, args = {}, signal?: AbortSignal) =>
  JSON.parse(await tools.find((tool) => tool.name === name)!.execute(args, context(signal)))

async function httpFixture(t: TestContext, capabilities?: ServerCapabilities) {
  const fixture = createFixture(capabilities)
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const servers = new Set([fixture.server])
  const clients = new Set<McpClient>()
  const headers: string[] = []
  const requests: Record<string, unknown>[] = []
  const http = createServer(async (req, res) => {
    headers.push(req.headers.authorization ?? '')
    const sessionId = req.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    if (!transport) {
      const next = createFixture(capabilities, fixture.state)
      const created = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, created)
        }
      })
      transport = created
      servers.add(next.server)
      await next.server.connect(transport)
    }
    const body: Buffer[] = []
    for await (const chunk of req) body.push(Buffer.from(chunk))
    if (body.length) requests.push(JSON.parse(Buffer.concat(body).toString()))
    const response = await transport.handleRequest(
      new Request('http://localhost/mcp', {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(body.length ? { body: Buffer.concat(body) } : {})
      })
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (fixture.state.stringifyResponseIds && response.headers.get('content-type')?.includes('application/json')) {
      const body = (await response.json()) as Record<string, unknown>
      if (typeof body.id === 'number') body.id = String(body.id)
      res.end(JSON.stringify(body))
    } else if (response.body) await pipeline(Readable.fromWeb(response.body), res).catch(() => {})
    else res.end()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(async () => {
    await Promise.all([...clients].map((client) => client.close()))
    await Promise.all([...servers].map((server) => server.close()))
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('missing HTTP address')
  const connect = async (
    serverName = 'alpha',
    permissions: McpPermissions = { tools: '*', resources: '*' },
    timeoutMs = 2000
  ) => {
    const client = await McpClient.connect({
      serverName,
      transport: 'streamable-http',
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: 'Bearer fixture-test' },
      permissions,
      timeoutMs
    })
    clients.add(client)
    return client
  }
  return { ...fixture, headers, requests, connect, url: `http://127.0.0.1:${address.port}/mcp` }
}

test('stdio로 도구를 실행하고 명시한 환경만 전달하며 종료 후 자식 프로세스를 정리한다', async (t) => {
  const previous = process.env.MCP_FIXTURE_SECRET
  process.env.MCP_FIXTURE_SECRET = 'not-a-real-secret'
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.MCP_FIXTURE_SECRET
    else process.env.MCP_FIXTURE_SECRET = previous
  })
  const client = await McpClient.connect({
    serverName: 'stdio',
    transport: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/stdio.ts', import.meta.url))],
    env: { MCP_FIXTURE_VALUE: 'explicit' },
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    permissions: { tools: ['subtract', 'environment'] },
    timeoutMs: 3000
  })
  t.onTestFinished(() => client.close())
  const tools = await client.tools()
  expect(await execute(tools, 'mcp__stdio__tool__subtract', { left: 13, right: 5 })).toMatchObject({
    structuredContent: { difference: 8 }
  })
  const result = await execute(tools, 'mcp__stdio__tool__environment')
  expect(result.structuredContent).toMatchObject({
    cwd: await realpath(fileURLToPath(new URL('..', import.meta.url))),
    configured: 'explicit',
    inheritedSecret: false
  })
  await client.close()
  expect(() => process.kill(result.structuredContent.pid, 0)).toThrow()
  await expect(tools[0]!.execute({}, context())).rejects.toThrow('closed')
})

test('HTTP 인증과 페이지 조회를 유지하고 서버별 도구 이름과 구조화 결과를 보존한다', async (t) => {
  const { connect, headers } = await httpFixture(t)
  const alpha = await connect()
  const beta = await connect('beta')
  const tools = await alpha.tools()
  expect(tools).toHaveLength(10)
  expect((await beta.tools())[0]!.name).toBe('mcp__beta__tool__subtract')
  expect(await execute(tools, 'mcp__alpha__tool__subtract', { left: 4, right: 11 })).toMatchObject({
    content: [{ type: 'text', text: '{"difference":-7}' }],
    structuredContent: { difference: -7 }
  })
  const unusual = tools.filter(
    (tool) => tool.description === 'a.b' || tool.description === 'a/b' || tool.description.startsWith('xxx')
  )
  expect(new Set(unusual.map((tool) => tool.name)).size).toBe(3)
  for (const tool of unusual) {
    expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(JSON.parse(await tool.execute({}, context())).structuredContent.name).toBe(tool.description)
  }
  expect((await alpha.tools()).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name))
  expect(headers.length).toBeGreaterThan(0)
  expect(headers.every((header) => header === 'Bearer fixture-test')).toBe(true)
  await expect(tools.find((tool) => tool.name.endsWith('__fail'))!.execute({}, context())).rejects.toThrow(
    'fixture failure'
  )
})

test('허용하지 않은 도구와 리소스를 숨기고 URI 접근을 서버 호출 전에 차단한다', async (t) => {
  const { connect, state } = await httpFixture(t)
  const denied = await connect('denied', {})
  expect(await denied.tools()).toEqual([])
  await expect(denied.listResources()).rejects.toThrow('denied')
  await expect(denied.readResource('fixture://public')).rejects.toThrow('denied')
  const names = ['subtract']
  const client = await connect('limited', { tools: names, resources: ['fixture://public'] })
  names.push('fail')
  const tools = await client.tools()
  expect(tools.map((tool) => tool.name)).toEqual([
    'mcp__limited__tool__subtract',
    'mcp__limited__resource__list',
    'mcp__limited__resource__read'
  ])
  expect(await execute(tools, 'mcp__limited__resource__list')).toMatchObject({
    resources: [{ uri: 'fixture://public' }]
  })
  await expect(client.readResource('fixture://private')).rejects.toThrow('denied')
  await expect(execute(tools, 'mcp__limited__resource__read', { uri: 'fixture://private' })).rejects.toThrow('denied')
  await expect(client.listResourceTemplates()).rejects.toThrow('denied')
  expect(state.resourceReads).toBe(0)
  expect(await execute(tools, 'mcp__limited__resource__read', { uri: 'fixture://public' })).toMatchObject({
    contents: [{ uri: 'fixture://public', text: 'resource body' }]
  })
  expect(state.resourceReads).toBe(1)
})

test('리소스 전용 서버에서 목록과 템플릿을 조회하고 확장한 URI를 읽는다', async (t) => {
  const { connect } = await httpFixture(t, { resources: {} })
  const client = await connect()
  const tools = await client.tools()
  expect(tools).toHaveLength(3)
  expect(await client.listResources()).toMatchObject({
    resources: [{ uri: 'fixture://public' }, { uri: 'fixture://private' }]
  })
  expect(await execute(tools, 'mcp__alpha__resource__templates')).toMatchObject({
    resourceTemplates: [{ uriTemplate: 'fixture://document/{id}' }]
  })
  expect(await client.readResource('fixture://document/42')).toMatchObject({
    contents: [{ uri: 'fixture://document/42' }]
  })
})

test('새 조회에는 도구 추가와 제거를 반영하고 조회 실패 시 기존 도구는 계속 실행한다', async (t) => {
  const { connect, state } = await httpFixture(t)
  const client = await connect()
  const original = await client.tools()
  state.names = ['new-tool']
  expect(
    (await client.tools()).filter((tool) => tool.name.includes('__tool__')).map((tool) => tool.description)
  ).toEqual(['new-tool'])
  state.failDiscovery = true
  await expect(client.tools()).rejects.toThrow('discovery failed')
  expect(await execute(original, 'mcp__alpha__tool__subtract', { left: 9, right: 2 })).toMatchObject({
    structuredContent: { difference: 7 }
  })
})

test.for(['abort', 'close', 'timeout'] as const)(
  '%s로 대기 중인 도구를 중단하고 취소를 서버에 전달한다',
  async (mode, t) => {
    const { connect, state } = await httpFixture(t)
    const client = await connect('alpha', { tools: '*' }, mode === 'timeout' ? 150 : 2000)
    const tools = await client.tools()
    const controller = new AbortController()
    const pending = tools.find((tool) => tool.name.endsWith('__wait'))!.execute({}, context(controller.signal))
    const rejected = expect(pending).rejects.toThrow()
    await state.started.promise
    if (mode === 'abort') controller.abort(new Error('cancel fixture'))
    if (mode === 'close') await client.close()
    await rejected
    await expect.poll(() => state.cancelled).toBe(true)
  }
)

test('MCP 도구 결과를 후속 생성과 세션에 저장한 뒤 RUN_FINISHED를 전달한다', async (t) => {
  const { connect } = await httpFixture(t)
  const client = await connect('calculator', { tools: ['subtract'] })
  const ctx = new Context()
  const followups: string[] = []
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 2000, maxOutputTokens: 200 }
    }
    async countTokens() {
      return 10
    }
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
      const result = request.input.messages.find((message) => message.role === 'tool')
      if (!result) {
        expect(request.input.tools.map((tool) => tool.name)).toEqual(['mcp__calculator__tool__subtract'])
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: 'subtract-call',
          toolCallName: 'mcp__calculator__tool__subtract'
        }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'subtract-call', delta: '{"left":3,"right":10}' }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'subtract-call' }
      } else {
        if (typeof result.content !== 'string') throw new Error('MCP tool result must be a JSON string')
        followups.push(result.content)
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'difference is -7' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
      }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(agentPlugin, {
    model: 'fixture',
    maxOutputTokens: 100,
    tools: (options) => client.tools(options)
  })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })
  const events = []
  for await (const event of ctx.agent.run({
    threadId: 'integration',
    runId: 'integration-run',
    state: {},
    context: [],
    tools: [],
    messages: [{ id: 'question', role: 'user', content: '3 - 10?' }]
  })) {
    events.push(event)
    if (event.type === EventType.RUN_FINISHED) {
      const session = await ctx.session.get('integration')
      expect(session?.messages.find((message) => message.role === 'tool')).toMatchObject({ content: followups[0] })
      expect(session?.messages.find((message) => message.id === 'answer')).toMatchObject({
        content: 'difference is -7'
      })
    }
  }
  expect(followups).toHaveLength(1)
  expect(JSON.parse(followups[0]!).structuredContent).toEqual({ difference: -7 })
  expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1)
})

test('연결 협상 중 취소하면 요청 시간 초과를 기다리지 않고 연결을 정리한다', async () => {
  const started = Date.now()
  await expect(
    McpClient.connect(
      {
        serverName: 'startup',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        timeoutMs: 4000
      },
      { signal: AbortSignal.timeout(100) }
    )
  ).rejects.toThrow(/abort|time/i)
  expect(Date.now() - started).toBeLessThan(2000)
})

test('서버 이름이 잘못됐거나 이미 취소했으면 연결하지 않는다', async () => {
  const config = { serverName: 'invalid name', transport: 'stdio' as const, command: 'missing-command' }
  await expect(McpClient.connect(config)).rejects.toThrow('serverName')
  await expect(McpClient.connect({ ...config, serverName: 'valid', timeoutMs: 0 })).rejects.toThrow('timeoutMs')
  await expect(
    McpClient.connect({ ...config, serverName: 'valid' }, { signal: AbortSignal.abort(new Error('cancelled')) })
  ).rejects.toThrow('cancelled')
})

const catalogTool = (name: string, description = name, inputSchema: Record<string, unknown> = { type: 'object' }) => ({
  name,
  description,
  inputSchema: { ...inputSchema, type: 'object' as const }
})

test('도구 목록의 페이지별 누적 개수를 제한하고 거부 후 기존 도구와 새 조회를 유지한다', async (t) => {
  const { connect, state } = await httpFixture(t)
  const client = await connect('limited', { tools: '*' })
  const original = await client.tools()
  state.catalog = [
    Array.from({ length: 128 }, (_, i) => catalogTool(`a${i}`)),
    Array.from({ length: 129 }, (_, i) => catalogTool(`b${i}`))
  ]
  await expect(client.tools()).rejects.toThrow('catalog exceeds')
  expect(await execute(original, 'mcp__limited__tool__subtract', { left: 7, right: 2 })).toMatchObject({
    structuredContent: { difference: 5 }
  })
  state.catalog = [[catalogTool('safe')]]
  expect((await client.tools()).map((tool) => tool.description)).toEqual(['safe'])
})

test('허용 목록 밖의 정의도 크기 검증에서 제외하지 않는다', async (t) => {
  const { connect, state } = await httpFixture(t)
  const client = await connect('limited', { tools: ['safe'] })
  state.catalog = [[catalogTool('safe'), catalogTool('denied', '가'.repeat(6000))]]
  await expect(client.tools()).rejects.toThrow('catalog exceeds')
})

test('개별 스키마와 출력 스키마의 깊이 및 크기를 SDK 검증 전에 제한한다', async (t) => {
  const { connect, state } = await httpFixture(t)
  const client = await connect('limited', { tools: '*' })
  let nested: Record<string, unknown> = { type: 'object' }
  for (let i = 0; i < 40; i++) nested = { type: 'object', properties: { child: nested } }
  for (const definition of [
    catalogTool('large', 'large', { type: 'object', description: 'x'.repeat(65 * 1024) }),
    catalogTool('deep', 'deep', nested),
    { ...catalogTool('output'), outputSchema: { ...nested, type: 'object' as const } }
  ]) {
    state.catalog = [[definition]]
    await expect(client.tools()).rejects.toThrow('catalog exceeds')
  }
})

test('개별 정의가 작아도 여러 페이지의 전체 바이트 예산을 넘으면 다음 페이지를 요청하지 않는다', async (t) => {
  const { connect, state } = await httpFixture(t)
  const client = await connect('limited', { tools: '*' })
  state.catalog = [
    Array.from({ length: 50 }, (_, i) => catalogTool(`a${i}`, 'x'.repeat(12000))),
    Array.from({ length: 50 }, (_, i) => catalogTool(`b${i}`, 'x'.repeat(12000))),
    [catalogTool('not-requested')]
  ]
  await expect(client.tools()).rejects.toThrow('catalog exceeds')
  expect(state.catalogRequests).toBe(2)
})

test('정상 경계 크기와 동시 조회는 서로 독립된 예산을 사용한다', async (t) => {
  const { connect, state } = await httpFixture(t)
  const client = await connect('limited', { tools: '*' })
  state.catalog = [
    Array.from({ length: 128 }, (_, i) => catalogTool(`a${i}`)),
    Array.from({ length: 128 }, (_, i) => catalogTool(`b${i}`))
  ]
  const lists = await Promise.all([client.tools(), client.tools()])
  expect(lists.map((tools) => tools.length)).toEqual([256, 256])
  state.catalog = [[catalogTool('description', 'x'.repeat(16 * 1024))]]
  expect((await client.tools())[0]!.description).toHaveLength(16 * 1024)
})

test('stdio에서 받은 과도한 도구 설명도 동일한 제한으로 거부한다', async (t) => {
  const client = await McpClient.connect({
    serverName: 'stdio',
    transport: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/stdio.ts', import.meta.url))],
    env: { MCP_FIXTURE_LARGE_CATALOG: '1' },
    permissions: { tools: '*' },
    timeoutMs: 3000
  })
  t.onTestFinished(() => client.close())
  await expect(client.tools()).rejects.toThrow('catalog exceeds')
})

test('캐시 없이도 도구 실행 시 출력 스키마 검증을 유지한다', async (t) => {
  const { connect, state } = await httpFixture(t)
  const client = await connect('limited', { tools: '*' })
  state.catalog = [
    [
      {
        ...catalogTool('subtract'),
        outputSchema: { type: 'object', properties: { difference: { type: 'number' } }, required: ['difference'] }
      }
    ]
  ]
  const tools = await client.tools()
  expect(await execute(tools, 'mcp__limited__tool__subtract', { left: 4, right: 1 })).toMatchObject({
    structuredContent: { difference: 3 }
  })
  state.catalog = [
    [
      {
        ...catalogTool('subtract'),
        outputSchema: { type: 'object', properties: { missing: { type: 'string' } }, required: ['missing'] }
      }
    ]
  ]
  await expect(execute(await client.tools(), 'mcp__limited__tool__subtract', { left: 4, right: 1 })).rejects.toThrow(
    'output schema'
  )
})

test('SDK가 허용하는 문자열 응답 ID도 같은 도구 목록 제한을 적용한다', async (t) => {
  const { connect, state } = await httpFixture(t)
  const client = await connect('limited', { tools: '*' })
  state.stringifyResponseIds = true
  state.catalog = [[catalogTool('safe')]]
  expect((await client.tools())[0]!.description).toBe('safe')
  state.catalog = [[catalogTool('large', 'x'.repeat(17 * 1024))]]
  await expect(client.tools()).rejects.toThrow('catalog exceeds')
})

test('브라우저 진입점으로 HTTP 도구를 조회하고 실행한다', async (t) => {
  const { url } = await httpFixture(t)
  const client = await BrowserMcpClient.connect({
    serverName: 'browser',
    transport: 'streamable-http',
    url,
    permissions: { tools: ['subtract'] }
  })
  t.onTestFinished(() => client.close())
  expect(await execute(await client.tools(), 'mcp__browser__tool__subtract', { left: 9, right: 4 })).toMatchObject({
    structuredContent: { difference: 5 }
  })
  await expect(BrowserMcpClient.connect({ serverName: 'local', transport: 'stdio', command: 'node' })).rejects.toThrow(
    'Node.js'
  )
})

test('MCP 설정 검증은 잘못된 권한과 전송 설정을 거부하고 원본을 복사한다', () => {
  const server = {
    serverName: 'remote',
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    permissions: { tools: ['search'] }
  }
  const parsed = parseMcpServers([server], false)
  server.permissions.tools.push('delete')
  expect(parsed[0]?.permissions?.tools).toEqual(['search'])
  for (const change of [
    { transport: 'sse' },
    { url: 'file:///tmp/server' },
    { permissions: { tools: true } },
    { timeoutMs: -1 },
    { headers: { Authorization: 'line\nbreak' } }
  ]) {
    expect(() => parseMcpServers([{ ...server, ...change }])).toThrow()
  }
})

test('브라우저에서도 누적 목록 예산을 분리하고 과도한 응답을 거부하며 내부 토큰을 전송하지 않는다', async (t) => {
  const { url, state, requests } = await httpFixture(t)
  const client = await BrowserMcpClient.connect({
    serverName: 'browser',
    transport: 'streamable-http',
    url,
    permissions: { tools: '*' }
  })
  t.onTestFinished(() => client.close())
  state.catalog = [
    Array.from({ length: 128 }, (_, i) => catalogTool(`a${i}`)),
    Array.from({ length: 128 }, (_, i) => catalogTool(`b${i}`))
  ]
  expect((await Promise.all([client.tools(), client.tools()])).map((tools) => tools.length)).toEqual([256, 256])
  state.catalog[1]!.push(catalogTool('extra'))
  await expect(client.tools()).rejects.toThrow('catalog exceeds')
  state.stringifyResponseIds = true
  state.catalog = [[catalogTool('large', '가'.repeat(6000))]]
  await expect(client.tools()).rejects.toThrow('catalog exceeds')
  state.catalog = [[catalogTool('safe')]]
  expect((await client.tools())[0]!.description).toBe('safe')
  expect(JSON.stringify(requests)).not.toContain('io.keundal/catalog-discovery')
})
