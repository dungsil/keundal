import 'fake-indexeddb/auto'
import { createServer } from 'node:http'
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { expect, test } from 'vitest'
import { createWebPlatform } from '../app/platform'
import { defaultLLMSettings } from '@keundal/llm-settings'

function storage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) },
    clear: () => data.clear()
  }
}

test('웹 조립은 네이티브 IPC 없이 IndexedDB 대화를 저장하고 재연결 후 복원한다', async () => {
  const platform = createWebPlatform(storage())
  await platform.mcp.load()
  await expect(platform.mcp.save([{ serverName: 'local', transport: 'stdio', command: 'node' }], async () => {})).rejects.toThrow('Streamable HTTP')
  const settings = defaultLLMSettings()
  const options = { getSettings: () => settings, getModels: () => [], skills: [] }
  expect(await platform.skills.listFiles()).toEqual({ roots: [], files: [] })
  const first = await platform.connect(options)
  const id = crypto.randomUUID()
  try {
    expect(first.remoteAgent).toBe(false)
    await first.store.create(id, { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }, 'openai/test')
  } finally {
    await first.dispose()
  }
  const second = await platform.connect(options)
  try {
    expect((await second.store.get(id))?.messages[0]?.id).toBe('user')
    await second.store.delete(id)
  } finally {
    await second.dispose()
  }
})

test('웹 조립은 활성 플러그인의 스킬과 허용한 MCP 도구를 실행하고 결과를 저장한다', async (t) => {
  const requests: Record<string, unknown>[] = []
  const calls: string[] = []
  let generations = 0
  const mcp = new Server({ name: 'reports', version: '1' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler('tools/list', () => ({ tools: [
    { name: 'search', description: 'Search reports', inputSchema: { type: 'object' } },
    { name: 'delete', description: 'Delete reports', inputSchema: { type: 'object' } }
  ] }))
  mcp.setRequestHandler('tools/call', (request) => {
    calls.push(request.params.name)
    return { content: [{ type: 'text', text: 'Total: 37' }] }
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => crypto.randomUUID() })
  await mcp.connect(transport)
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (request.url === '/mcp') {
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      const result = await transport.handleRequest(new Request('http://localhost/mcp', {
        method: request.method, headers: request.headers as Record<string, string>, body: Buffer.concat(chunks)
      }))
      response.writeHead(result.status, Object.fromEntries(result.headers)).end(Buffer.from(await result.arrayBuffer()))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (request.url?.endsWith('/input_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":40}')
      return
    }
    const title = JSON.stringify(body.input).includes('Generate a chat title')
    if (!title) requests.push(body)
    const tool = body.tools?.find((tool: { name: string }) => tool.name?.startsWith('mcp__plugin_') && tool.name.endsWith('__search'))
    const outputs = !title && generations++ === 0
      ? [
          { type: 'function_call', id: 'fc_skill', call_id: 'skill_call', name: 'skill', arguments: '{"name":"review"}' },
          { type: 'function_call', id: 'fc_mcp', call_id: 'mcp_call', name: tool?.name ?? 'missing-plugin-tool', arguments: '{}' }
        ]
      : [{ type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Checked: 37', annotations: [] }] }]
    const frames: Record<string, unknown>[] = outputs.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item },
      { type: 'response.output_item.done', output_index, item }
    ])
    frames.push({ type: 'response.completed', response: { id: 'response', status: 'completed' } })
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(async () => {
    await mcp.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const endpoint = `http://127.0.0.1:${address.port}`
  const platform = createWebPlatform(storage())
  const markdown = '---\nname: review\ndescription: Review totals\n---\nCompare totals independently.'
  await platform.plugins!.import({
    'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'reports' }),
    'skills/review/SKILL.md': markdown,
    'mcp.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {
      reports: { type: 'streamable-http', url: `${endpoint}/mcp` }
    } })
  }, async () => {})
  await platform.plugins!.configure('reports', { enabled: true, permissions: { reports: { tools: ['search'] } } }, async () => {})
  const settings = defaultLLMSettings()
  settings.openai = { apiKey: 'test-key', baseURL: `${endpoint}/v1` }
  const connection = await platform.connect({ getSettings: () => settings, getModels: () => [], skills: [] })
  t.onTestFinished(() => connection.dispose())
  const id = crypto.randomUUID()
  const user = { id: 'user', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Review report' }] }
  await connection.store.create(id, user, 'openai/test')
  const events = []
  for await (const event of connection.store.respond(id, { model: 'openai/test', messages: [user] })) events.push(event)
  expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: 'RUN_FINISHED' })
  expect(calls, JSON.stringify({ requests, events })).toEqual(['search'])
  expect(JSON.stringify(requests[0]!.tools)).not.toContain('__delete')
  expect(JSON.stringify(requests[1]!.input)).toContain('Compare totals independently.')
  expect(JSON.stringify(requests[1]!.input)).toContain('Total: 37')
  expect((await connection.store.get(id))!.messages[1]!.parts).toContainEqual({ type: 'text', text: 'Checked: 37' })
  await connection.store.delete(id)
})
