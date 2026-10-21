import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import { createAgentHost } from '../src/index.js'

const directories: string[] = []
const hosts: Awaited<ReturnType<typeof createAgentHost>>[] = []

const sqlitePath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-agent-host-'))
  directories.push(directory)
  return join(directory, 'store.sqlite')
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('설정한 모델 목록과 기본 모델을 노출한다', async () => {
  const host = await createAgentHost({
    provider: 'openai',
    apiKey: 'test-key',
    model: 'small',
    models: {
      small: { contextWindow: 8000, maxOutputTokens: 1000 },
      large: { contextWindow: 16000, maxOutputTokens: 2000 }
    },
    sqlitePath: sqlitePath()
  })
  hosts.push(host)

  expect(host.model).toBe('small')
  expect(host.services.models()).toEqual([
    { id: 'small', provider: 'openai', contextWindow: 8000, maxOutputTokens: 1000 },
    { id: 'large', provider: 'openai', contextWindow: 16000, maxOutputTokens: 2000 }
  ])
})

test('설정에 없는 모델로 실행하면 거부한다', async () => {
  const host = await createAgentHost({
    provider: 'openai',
    apiKey: 'test-key',
    model: 'small',
    models: { small: { contextWindow: 8000, maxOutputTokens: 1000 } },
    sqlitePath: sqlitePath()
  })
  hosts.push(host)

  expect(() =>
    host.services.run(
      {
        threadId: 'thread',
        runId: 'run',
        state: {},
        tools: [],
        context: [],
        messages: []
      },
      { model: 'missing' }
    )
  ).toThrow('model is not configured')
})

test('기본 모델이 모델 목록에 없으면 호스트 생성을 거부한다', async () => {
  await expect(
    createAgentHost({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'missing',
      models: { small: { contextWindow: 8000, maxOutputTokens: 1000 } },
      sqlitePath: sqlitePath()
    })
  ).rejects.toThrow('default model is not configured')
})

test.each(['array', 'provider'])('호스트는 기본 도구(%s)와 MCP 도구를 함께 제공하고 제목을 생성한다', async (kind) => {
  const http = await import('node:http')
  const replies: string[] = []
  const requests: string[] = []
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/responses/input_tokens') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      requests.push(body)
      const title = body.includes('Generate a chat title')
      const text = title ? '테스트 제목' : '테스트 응답'
      replies.push(text)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } })}\n\n`
      )
      response.write(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: 'test', output: [], parallel_tool_calls: false, tool_choice: 'auto', tools: [] } })}\n\n`
      )
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  const host = await createAgentHost({
    provider: 'openai',
    apiKey: 'test-key',
    model: 'test',
    models: { test: { contextWindow: 8000, maxOutputTokens: 1000 } },
    sqlitePath: sqlitePath(),
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    tools:
      kind === 'provider'
        ? async () => [
            { name: 'local_tool', description: 'Local', parameters: { type: 'object' }, execute: async () => '{}' }
          ]
        : [{ name: 'local_tool', description: 'Local', parameters: { type: 'object' }, execute: async () => '{}' }],
    mcpServers: [
      {
        serverName: 'fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [
          '-e',
          `
        const readline = require('node:readline');
        readline.createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          const result = request.method === 'initialize'
            ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            : { tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } }] };
          console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        });
      `
        ],
        permissions: { tools: ['search'] },
        timeoutMs: 3000
      }
    ]
  })
  hosts.push(host)
  try {
    const events = []
    for await (const event of host.services.run({
      threadId: 'thread',
      runId: 'run',
      state: {},
      tools: [],
      context: [],
      messages: [{ id: 'user', role: 'user', content: '안녕하세요' }]
    })) {
      events.push(event)
    }
    expect(events).toContainEqual({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: '테스트 응답' })
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
    expect((await host.services.session.get('thread'))?.messages).toEqual([
      expect.objectContaining({ role: 'assistant' })
    ])
    const title = await host.services.title({
      model: 'test',
      message: { id: 'user', role: 'user', content: '안녕하세요' }
    })
    expect(title).toBe('테스트 제목')
    expect(requests.find((body) => !body.includes('Generate a chat title'))).toContain('mcp__fixture__tool__search')
    expect(requests.find((body) => body.includes('Generate a chat title'))).not.toContain('mcp__fixture__tool__search')
    expect(requests.find((body) => !body.includes('Generate a chat title'))).toContain('local_tool')
    expect(requests.find((body) => body.includes('Generate a chat title'))).not.toContain('local_tool')
    expect(replies).toEqual(['테스트 응답', '테스트 제목'])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('런타임에 등록한 도구를 실행하고 결과를 후속 요청에 넣어 최종 답변을 저장한다', async (t) => {
  const { createServer } = await import('node:http')
  const { createAgentRuntime } = await import('../src/runtime.js')
  const requests: Record<string, unknown>[] = []
  const executions: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/responses/input_tokens') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body) as Record<string, unknown>
    requests.push(parsed)
    const followup = (parsed.input as { type?: string }[]).some((item) => item.type === 'function_call_output')
    const item = followup
      ? {
          id: 'answer',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '보르도는 흐립니다.', annotations: [] }]
        }
      : {
          id: 'weather_call',
          type: 'function_call',
          call_id: 'call_1',
          name: 'weather',
          arguments: '{"location":"Bordeaux"}',
          status: 'completed'
        }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'response', status: 'completed' } }
    ])
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  const host = await createAgentRuntime(
    {
      KEUNDAL_PROVIDER: 'openai',
      KEUNDAL_API_TOKEN: 'test-token',
      OPENAI_API_KEY: 'test-key',
      KEUNDAL_MODEL: 'test',
      KEUNDAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      KEUNDAL_SQLITE_PATH: sqlitePath()
    },
    {
      tools: [
        {
          name: 'weather',
          description: 'Test weather',
          parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
          execute: async (args) => {
            executions.push(args)
            return '{"condition":"cloudy"}'
          }
        }
      ]
    }
  )
  hosts.push(host)
  const events = []
  for await (const event of host.services.run({
    threadId: 'weather-thread',
    runId: 'weather-run',
    state: {},
    tools: [],
    context: [],
    messages: [{ id: 'user', role: 'user', content: '보르도의 날씨는 어떤가요?' }]
  }))
    events.push(event)
  expect(executions).toEqual([{ location: 'Bordeaux' }])
  expect(requests).toHaveLength(2)
  expect(requests[0]?.tools).toEqual([
    expect.objectContaining({ name: 'weather', type: 'function' }),
    expect.objectContaining({ name: 'delegate_task', type: 'function' })
  ])
  expect(requests[1]?.input).toContainEqual({
    type: 'function_call_output',
    call_id: 'call_1',
    output: '{"condition":"cloudy"}'
  })
  expect(events).toContainEqual(expect.objectContaining({ type: 'TEXT_MESSAGE_CONTENT', delta: '보르도는 흐립니다.' }))
  expect(events.at(-1)?.type).toBe('RUN_FINISHED')
  expect(await host.services.generation.get('weather-run')).toMatchObject({ status: 'completed' })
})

test('Agent Plugin 스킬을 호스트에 등록하고 종료하면 사용할 수 없다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-host-plugins-'))
  directories.push(directory)
  const root = join(directory, 'plugin')
  mkdirSync(join(root, 'skills', 'hello'), { recursive: true })
  writeFileSync(
    join(root, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'test'
    })
  )
  writeFileSync(join(root, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: Test\n---\nHello')
  const host = await createAgentHost({
    provider: 'openai',
    apiKey: 'test',
    model: 'small',
    sqlitePath: sqlitePath(),
    plugins: [{ root, dataDirectory: join(directory, 'data') }]
  })
  hosts.push(host)
  expect(host.plugins).toHaveLength(1)
  expect((await host.ctx.skills.prepare()).skills).toEqual([{ name: 'hello', description: 'Test' }])
  const catalog = await host.ctx.skills.prepare()
  await host.dispose()
  await expect(catalog.load('hello')).rejects.toThrow()
})
