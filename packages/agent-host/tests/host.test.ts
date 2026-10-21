import { mkdtempSync, rmSync } from 'node:fs'
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

test('호스트는 모델별 에이전트로 실행하고 제목을 생성한다', async () => {
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
    expect(replies).toEqual(['테스트 응답', '테스트 제목'])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
