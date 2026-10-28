import { createServer } from 'node:http'
import { Context } from 'cordis'
import { EventType } from '@keundal/core'
import { LLMService, type LLMRequest, type LLMEvent } from '@keundal/llm'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { createKeundalChat } from '@keundal/plugin-chat-local/keundal'
import agentPlugin from '@keundal/plugin-agent-chat'
import { createChartTools } from '@keundal/plugin-tool-chart'
import { createWeatherTools } from '@keundal/plugin-tool-weather'
import type { invoke } from '@tauri-apps/api/core'
import { expect, test, vi, type TestContext } from 'vitest'
import { McpManager, createBrowserMcpSettingsStorage } from '@keundal/plugin-chat-browser/mcp'
import { createNativeMcpSettingsStorage } from '@keundal/plugin-chat-desktop/mcp'

function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
}
const remote = { serverName: 'docs', transport: 'streamable-http', url: 'https://example.com/mcp', permissions: { tools: ['search'] } }

test('주입한 비동기 저장소의 저장이 끝난 뒤에 호스트를 재시작한다', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let saved: string | null = null
  const manager = new McpManager({
    load: async () => saved,
    save: async (value) => {
      await pending
      saved = value
    }
  })
  const restart = vi.fn(async () => {
    expect(JSON.parse(saved!)).toEqual([remote])
  })
  const saving = manager.save([remote], restart)
  await Promise.resolve()
  expect(restart).not.toHaveBeenCalled()
  expect(manager.configuration).toEqual([])
  release()
  await saving
  expect(restart).toHaveBeenCalledOnce()
  expect(manager.configuration).toEqual([remote])
})

test('웹 설정을 저장하고 다시 불러오며 삭제하면 저장소를 비운다', async () => {
  const local = storage()
  const manager = new McpManager(createBrowserMcpSettingsStorage(local))
  const restart = vi.fn(async () => {})
  await manager.save([remote], restart)
  const restored = new McpManager(createBrowserMcpSettingsStorage(local))
  await restored.load()
  expect(restored.configuration).toEqual([remote])
  expect(restart).toHaveBeenCalledOnce()
  await manager.save([], restart)
  expect(local.values.size).toBe(0)
})

test('웹에서 stdio와 중복 서버를 거부하고 기존 설정을 유지한다', async () => {
  const manager = new McpManager(createBrowserMcpSettingsStorage(storage()))
  const restart = vi.fn(async () => {})
  await manager.save([remote], restart)
  await expect(manager.save([{ serverName: 'local', transport: 'stdio', command: 'node' }], restart)).rejects.toThrow('Streamable HTTP')
  await expect(manager.save([remote, remote], restart)).rejects.toThrow('Duplicate')
  expect(manager.configuration).toEqual([remote])
  expect(restart).toHaveBeenCalledOnce()
})

test('호스트 재시작에 실패하면 저장된 설정과 적용 중인 설정을 되돌린다', async () => {
  const local = storage()
  const manager = new McpManager(createBrowserMcpSettingsStorage(local))
  await manager.save([remote], async () => {})
  await expect(manager.save([], async () => {
    throw new Error('restart failed')
  })).rejects.toThrow('restart failed')
  const restored = new McpManager(createBrowserMcpSettingsStorage(local))
  await restored.load()
  expect(manager.configuration).toEqual([remote])
  expect(restored.configuration).toEqual([remote])
})

test('데스크톱의 stdio 인증 정보는 OS 보안 저장소만 사용한다', async () => {
  const local = storage()
  let saved: string | null = null
  const native = vi.fn(async (command: string, args?: { settings: string | null }) => {
    if (command === 'load_mcp_settings') return saved
    if (command === 'save_mcp_settings') saved = args!.settings
    return null
  }) as unknown as typeof invoke
  const manager = new McpManager(createNativeMcpSettingsStorage(native), { allowStdio: true })
  const config = { serverName: 'local', transport: 'stdio', command: 'node', env: { TOKEN: 'test-value' } }
  await manager.save([config], async () => {})
  const restored = new McpManager(createNativeMcpSettingsStorage(native), { allowStdio: true })
  await restored.load()
  expect(restored.configuration).toEqual([config])
  expect(local.values.size).toBe(0)
})

test('보안 저장소에 접근하지 못하면 브라우저 저장소로 대체하지 않는다', async () => {
  const local = storage()
  const native = vi.fn(async () => {
    throw new Error('locked')
  }) as unknown as typeof invoke
  const manager = new McpManager(createNativeMcpSettingsStorage(native), { allowStdio: true })
  await expect(manager.load()).rejects.toThrow('locked')
  await expect(manager.save([remote], async () => {})).rejects.toThrow('locked')
  expect(local.values.size).toBe(0)
})

test('웹 대화의 에이전트는 MCP 도구를 실행하고 결과를 모델에 전달한다', async (t) => {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel() { return { contextWindow: 128000, maxOutputTokens: 4096 } }
    async countTokens() { return 40 }
    async* stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push(structuredClone(request))
      if (requests.length === 1) {
        yield { type: EventType.TOOL_CALL_START, toolCallId: 'load', toolCallName: 'mcp__docs__tool__search' }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'load', delta: '{}' }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'load' }
      } else {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'Reviewed' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
      }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  t.onTestFinished(async () => {
    await store.dispose()
    await llm.dispose()
  })
  const tools = vi.fn(async () => [{ name: 'mcp__docs__tool__search', description: 'Search', parameters: { type: 'object' }, execute: async () => JSON.stringify({ content: [{ type: 'text', text: 'MCP search result' }] }) }])
  const runtime = await createKeundalChat(ctx, 'openai/gpt-5-nano', {}, async (ctx, config) => ctx.plugin(agentPlugin, { ...config, tools: async () => [...createChartTools(), ...createWeatherTools(), ...await tools()] }))
  t.onTestFinished(() => runtime.dispose())
  const events = []
  for await (const event of runtime.respond({ threadId: 'chat', instructions: 'Be helpful.', messages: [{ id: 'question', role: 'user', parts: [{ type: 'text', text: 'Review my code.' }] }] })) events.push(event)
  expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: EventType.RUN_FINISHED })
  expect(tools).toHaveBeenCalledOnce()
  expect(JSON.stringify(requests[0])).toContain('mcp__docs__tool__search')
  expect(JSON.stringify(requests[0])).toContain('weather')
  expect(requests[1]!.input.messages).toContainEqual(expect.objectContaining({ role: 'tool', content: JSON.stringify({ content: [{ type: 'text', text: 'MCP search result' }] }) }))
})

test('데스크톱 서버별 HTTP 허용을 저장하고 다시 불러와도 다른 서버에는 적용하지 않는다', async () => {
  const local = storage()
  let saved: string | null = null
  const native = vi.fn(async (command: string, args?: { settings: string | null }) => {
    if (command === 'load_mcp_settings') return saved
    if (command === 'save_mcp_settings') saved = args!.settings
    return null
  }) as unknown as typeof invoke
  const manager = new McpManager(createNativeMcpSettingsStorage(native), { allowStdio: true })
  const config = { ...remote, url: 'http://192.168.1.20/mcp', allowInsecureHttp: true }
  await manager.save([config], async () => {})
  const restored = new McpManager(createNativeMcpSettingsStorage(native), { allowStdio: true })
  await restored.load()
  expect(restored.configuration).toEqual([config])
  await expect(restored.save([config, { ...remote, serverName: 'other', url: config.url }], async () => {})).rejects.toThrow('HTTPS')
  expect(restored.configuration).toEqual([config])
  expect(local.values.size).toBe(0)
})

async function jsonRpcServer(t: TestContext, bearer?: string) {
  const calls: string[] = []
  const http = createServer(async (req, res) => {
    if (bearer && req.headers.authorization !== `Bearer ${bearer}`) {
      res.writeHead(401).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    if (req.method === 'GET') {
      res.writeHead(405).end()
      return
    }
    if (req.method === 'DELETE') {
      calls.push('DELETE')
      res.writeHead(200).end()
      return
    }
    const message = JSON.parse(Buffer.concat(chunks).toString())
    calls.push(message.method)
    if (message.id === undefined) {
      res.writeHead(202).end()
      return
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'docs', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'search', description: 'Search docs', inputSchema: { type: 'object' } }, { name: 'delete_all', inputSchema: { type: 'object' } }] }
        : message.method === 'resources/list'
          ? { resources: [{ name: 'guide', uri: 'docs://guide' }] }
          : undefined
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(result ? { result } : { error: { code: -32601, message: 'Method not found' } }) }))
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(async () => {
    http.closeAllConnections()
    await new Promise<void>(resolve => http.close(() => resolve()))
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('missing HTTP address')
  return { calls, url: `http://127.0.0.1:${address.port}/mcp` }
}

test('저장하지 않은 설정으로 연결을 확인하면 도구 목록을 돌려주고 도구를 호출하지 않으며 저장된 설정을 바꾸지 않는다', async (t) => {
  const { calls, url } = await jsonRpcServer(t)
  const local = storage()
  const manager = new McpManager(createBrowserMcpSettingsStorage(local))
  await manager.save([remote], async () => {})
  const saved = [...local.values.entries()]
  const result = await manager.probe({ serverName: 'draft', transport: 'streamable-http', url, permissions: {} })
  expect(result.tools).toEqual([{ name: 'search', description: 'Search docs' }, { name: 'delete_all' }])
  expect(result.resources).toEqual({ supported: true, count: 1 })
  expect(calls).toContain('tools/list')
  expect(calls).not.toContain('tools/call')
  expect(calls.at(-1)).toBe('DELETE')
  expect(manager.configuration).toEqual([remote])
  expect([...local.values.entries()]).toEqual(saved)
})

test.for(['고정 계정', '설정별 계정'] as const)('%s으로 연결과 확인을 인증하고 서버 설정에 토큰을 저장하지 않는다', async (mode, t) => {
  const { url } = await jsonRpcServer(t, 'account-token')
  const local = storage()
  const authentication = {
    serverUrl: url,
    signal: new AbortController().signal,
    token: async () => 'account-token',
    onUnauthorized: async () => { throw new Error('Login required') }
  }
  const manager = new McpManager(createBrowserMcpSettingsStorage(local), mode === '고정 계정'
    ? { authentication: { docs: authentication } }
    : { getAuthentication: async (server) => server.serverName === 'docs' ? authentication : undefined })
  t.onTestFinished(() => manager.close())
  await manager.save([{ ...remote, url }], async () => {})
  expect((await manager.probe({ ...remote, url })).tools.map(tool => tool.name)).toEqual(['search', 'delete_all'])
  expect((await manager.tools()).map(tool => tool.name)).toEqual(['mcp__docs__tool__search'])
  expect([...local.values.values()].join(' ')).not.toContain('account-token')
})

test('도달할 수 없는 서버는 확인에 실패하고 저장된 설정을 유지한다', async () => {
  const local = storage()
  const manager = new McpManager(createBrowserMcpSettingsStorage(local))
  await manager.save([remote], async () => {})
  const fetch = vi.fn(async () => {
    throw new TypeError('Failed to fetch')
  })
  vi.stubGlobal('fetch', fetch)
  try {
    await expect(manager.probe({ ...remote, serverName: 'draft', permissions: {} })).rejects.toThrow('Failed to fetch')
    expect(fetch).toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
  expect(manager.configuration).toEqual([remote])
})

test('연결 확인은 stdio와 잘못된 설정을 연결하기 전에 거부한다', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 500 }))
  vi.stubGlobal('fetch', fetch)
  try {
    const web = new McpManager(createBrowserMcpSettingsStorage(storage()))
    await expect(web.probe({ serverName: 'local', transport: 'stdio', command: 'node' })).rejects.toThrow('Streamable HTTP')
    const desktop = new McpManager(createNativeMcpSettingsStorage(vi.fn() as unknown as typeof invoke), { allowStdio: true })
    await expect(desktop.probe({ serverName: 'local', transport: 'stdio', command: 'node' })).rejects.toThrow('Streamable HTTP')
    await expect(web.probe({ serverName: 'draft', transport: 'streamable-http', url: 'http://example.com/mcp' })).rejects.toThrow('HTTPS')
    await expect(web.probe({ serverName: 'bad name', transport: 'streamable-http', url: 'https://example.com/mcp' })).rejects.toThrow('name')
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

test('이미 취소한 연결 확인은 서버에 요청하지 않는다', async (t) => {
  const { calls, url } = await jsonRpcServer(t)
  const manager = new McpManager(createBrowserMcpSettingsStorage(storage()))
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await expect(manager.probe({ serverName: 'draft', transport: 'streamable-http', url }, { signal: controller.signal })).rejects.toThrow('cancelled')
  expect(calls).toEqual([])
})

test('연결 모듈을 불러오는 동안 닫으면 서버에 연결하지 않고 다음 요청에서는 새 연결을 사용한다', async (t) => {
  const { calls, url } = await jsonRpcServer(t)
  const manager = new McpManager(createBrowserMcpSettingsStorage(storage()))
  t.onTestFinished(() => manager.close())
  await manager.save([{ ...remote, url }], async () => {})

  const pending = manager.tools()
  const closing = manager.close()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await closing
  expect(calls).toEqual([])

  const tools = await manager.tools()
  expect(tools.map(tool => tool.name)).toEqual(['mcp__docs__tool__search'])
  expect(calls.filter(method => method === 'initialize')).toHaveLength(1)
})
