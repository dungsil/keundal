import 'fake-indexeddb/auto'
import { createServer } from 'node:http'
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { expect, test } from 'vitest'
import { readTraceSpans, summarizeTrace } from '@keundal/core'
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

test('번들 스킬과 도구의 on/off를 실제 목록에 반영하고 재연결해도 선택과 대화를 보존한다', async () => {
  const saved = storage()
  saved.setItem('keundal:runtime-plugins', JSON.stringify([{ module: 'https://not-requested.invalid/plugin.mjs', enabled: true }]))
  const platform = createWebPlatform(saved)
  const settings = defaultLLMSettings()
  const options = {
    getSettings: () => settings, getModels: () => [],
    skills: [{ name: 'reports', prepare: async () => ({
      skills: [{ name: 'review', description: 'Review reports' }],
      load: async () => ({ name: 'review', description: 'Review reports', content: 'Check the totals.' })
    }) }]
  }
  const connection = await platform.connect(options)
  const id = crypto.randomUUID()
  try {
    expect((await platform.runtimePlugins!.list()).map(entry => entry.module)).toEqual([
      '@keundal/plugin-llm-browser', '@keundal/plugin-store-indexeddb', '@keundal/plugin-agent-chat',
      '@keundal/plugin-skill', '@keundal/plugin-tool-chat', '@keundal/plugin-mcp-client'
    ])
    await expect(platform.runtimePlugins!.setEnabled('https://not-requested.invalid/plugin.mjs', true)).rejects.toThrow('Unknown bundled')
    await expect(platform.runtimePlugins!.setEnabled('@keundal/plugin-store-indexeddb', false)).rejects.toThrow('Required')
    expect(await connection.catalog!()).toMatchObject({ skills: [{ name: 'review' }], tools: [{ name: 'chart' }, { name: 'weather' }] })
    await connection.store.create(id, { id: 'retained', role: 'user', parts: [{ type: 'text', text: 'Keep this chat' }] }, 'openai/test')
    await platform.runtimePlugins!.setEnabled('@keundal/plugin-skill', false)
    await platform.runtimePlugins!.setEnabled('@keundal/plugin-tool-chat', false)
    expect(await connection.catalog!()).toEqual({ skills: [], tools: [] })
    await platform.runtimePlugins!.setEnabled('@keundal/plugin-skill', true)
    expect((await connection.catalog!()).skills).toEqual([{ name: 'review', description: 'Review reports' }])
    await platform.runtimePlugins!.setEnabled('@keundal/plugin-skill', false)
  } finally {
    await connection.dispose()
  }
  const restored = await platform.connect(options)
  try {
    expect(await restored.catalog!()).toEqual({ skills: [], tools: [] })
    expect((await restored.store.get(id))?.messages[0]?.id).toBe('retained')
    await platform.runtimePlugins!.setEnabled('@keundal/plugin-tool-chat', true)
    expect((await restored.catalog!()).tools.map(tool => tool.name)).toEqual(['chart', 'weather'])
    await restored.store.delete(id)
  } finally {
    await restored.dispose()
  }
})

test.for([false, true])('웹 조립은 Deferred Tools=%s에서 허용한 MCP 도구와 스킬을 실행하고 Journal을 저장한다', async (deferred, t) => {
  const requests: Record<string, unknown>[] = []
  const calls: string[] = []
  let generations = 0
  const formatted = '## Report\n\n| Item | Total |\n| --- | --- |\n| A | 37 |'
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
    if (request.url === '/keundal.plugins.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }, { module: 'builtin:skills' }],
        agent: { module: 'builtin:agent', config: { deferredTools: {} } },
        tools: [{ module: 'builtin:chat-tools' }]
      }))
      return
    }
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
    const round = title ? -1 : generations++
    const outputs = !title && deferred && round === 0
      ? [{ type: 'function_call', id: 'fc_search', call_id: 'search_call', name: 'search_tool', arguments: '{"query":"search reports"}' }]
      : !title && round === (deferred ? 1 : 0)
        ? [
            { type: 'function_call', id: 'fc_skill', call_id: 'skill_call', name: 'skill', arguments: '{"name":"review"}' },
            { type: 'function_call', id: 'fc_mcp', call_id: 'mcp_call', name: tool?.name ?? 'missing-plugin-tool', arguments: '{}' },
            { type: 'function_call', id: 'fc_markdown', call_id: 'markdown_call', name: 'markdown', arguments: JSON.stringify({ content: formatted }) }
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
  const platform = createWebPlatform(storage(), deferred ? { pluginConfig: `${endpoint}/keundal.plugins.json` } : {})
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
  for await (const event of connection.store.respond(id, { model: 'openai/test', messages: [user], systemPrompt: 'Answer in two sentences.' })) events.push(event)
  expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: 'RUN_FINISHED' })
  expect(JSON.stringify(requests[0]!.input)).toContain('Answer in two sentences.')
  expect(JSON.stringify(requests[0]!.input)).toContain('You are a knowledgeable and helpful AI assistant.')
  expect(JSON.stringify(requests[0]!.input)).toContain('Write normal responses in plain text')
  expect(JSON.stringify(requests[0]!.input)).toContain('use the markdown tool if available')
  expect(calls, JSON.stringify({ requests, events })).toEqual(['search'])
  expect(JSON.stringify(requests.map(request => request.tools))).not.toContain('__delete')
  if (deferred) {
    expect(JSON.stringify(requests[0]!.tools)).toContain('search_tool')
    expect(JSON.stringify(requests[0]!.tools)).not.toContain('mcp__')
    expect(JSON.stringify(requests[1]!.tools)).toContain('__search')
  }
  const followup = requests[deferred ? 2 : 1]!
  expect(JSON.stringify(followup.input)).toContain('Compare totals independently.')
  expect(JSON.stringify(followup.input)).toContain('Total: 37')
  const toolResult = (followup.input as { type?: string, call_id?: string, output?: string }[])
    .find(item => item.type === 'function_call_output' && item.call_id === 'markdown_call')
  expect(JSON.parse(toolResult!.output!)).toEqual({ displayed: true })
  expect((await connection.store.get(id))!.messages[1]!.parts).toContainEqual({
    type: 'tool-markdown', toolCallId: 'markdown_call', state: 'output-available',
    input: { content: formatted }, output: { displayed: true }
  })
  const changedStart = requests.length
  for await (const event of connection.store.respond(id, { model: 'openai/test', messages: [user], systemPrompt: 'Use bullet points.' })) void event
  const changedInput = JSON.stringify(requests[changedStart]!.input)
  expect(changedInput).toContain('Use bullet points.')
  expect(changedInput).not.toContain('Answer in two sentences.')
  const clearedStart = requests.length
  for await (const event of connection.store.respond(id, { model: 'openai/test', messages: [user], systemPrompt: ' \n ' })) void event
  const clearedInput = JSON.stringify(requests[clearedStart]!.input)
  expect(clearedInput).not.toContain('Use bullet points.')
  expect(clearedInput).toContain('You are a knowledgeable and helpful AI assistant.')
  const answer = (await connection.store.get(id))!.messages[1]!
  expect(answer.parts).toContainEqual({ type: 'text', text: 'Checked: 37' })
  const run = await connection.store.getRun?.(answer.id)
  expect(run?.status).toBe('completed')
  expect(run?.journal.map(entry => entry.event)).toContainEqual(expect.objectContaining({ type: 'CUSTOM', name: 'keundal.trace' }))
  await connection.store.delete(id)
})

test('웹 조립은 배포한 매니페스트의 가격표로 공급자가 비용을 주지 않은 실행의 추정 비용을 Trace에 저장한다', async (t) => {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    if (request.url === '/keundal.plugins.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }, { module: 'builtin:skills' }],
        agent: {
          module: 'builtin:agent',
          config: {
            pricing: {
              currency: 'USD',
              models: { 'openai/test': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 } }
            }
          }
        },
        tools: [{ module: 'builtin:chat-tools' }]
      }))
      return
    }
    if (request.url?.endsWith('/input_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":40}')
      return
    }
    const item = { type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Priced', annotations: [] }] }
    const frames = [
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: 'response',
          status: 'completed',
          usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 400 } }
        }
      }
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  t.onTestFinished(async () => {
    server.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const endpoint = `http://127.0.0.1:${address.port}`
  const platform = createWebPlatform(storage(), { pluginConfig: `${endpoint}/keundal.plugins.json` })
  const settings = defaultLLMSettings()
  settings.openai = { apiKey: 'test-key', baseURL: `${endpoint}/v1` }
  const connection = await platform.connect({ getSettings: () => settings, getModels: () => [], skills: [] })
  t.onTestFinished(() => connection.dispose())
  const id = crypto.randomUUID()
  const user = { id: 'user', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Price this run' }] }
  await connection.store.create(id, user, 'openai/test')
  for await (const event of connection.store.respond(id, { model: 'openai/test', messages: [user] })) void event
  const answer = (await connection.store.get(id))!.messages[1]!
  const run = await connection.store.getRun?.(answer.id)
  const cost = summarizeTrace(readTraceSpans(run!.journal.map(entry => entry.event), answer.id)).cost
  // 일반 입력 600 × 3 + 캐시 읽기 400 × 0.3 + 출력 200 × 15 (100만 토큰 기준)
  expect(cost).toMatchObject({ currency: 'USD', complete: true, source: 'estimate' })
  expect(cost?.amount).toBeCloseTo(0.00492, 9)
  await connection.store.delete(id)
})
