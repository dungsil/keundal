import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpClient } from '@keundal/plugin-mcp-client'
import { McpClient as BrowserMcpClient } from '@keundal/plugin-mcp-client/browser'
import { expect, test, vi, type TestContext } from 'vitest'

const limit = 2 * 1024 * 1024
const payload = 'WIRE_PAYLOAD'.repeat(Math.ceil(limit / 6))
const config = {
  serverName: 'wire',
  transport: 'streamable-http' as const,
  url: 'http://localhost/mcp',
  timeoutMs: 1000
}

function fixture(t: TestContext, attack: string, framing = 'json', contentLength = false) {
  let received = 0
  let cancelled = false
  let sent = false
  let total = 0
  const parse = JSON.parse
  const parsing = vi.spyOn(JSON, 'parse')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'GET' && attack !== 'GET') return new Response(null, { status: 405 })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    const request = init?.method === 'GET' ? { method: 'GET', id: 0 } : parse(String(init?.body))
    if (!('id' in request) && request.method !== attack) return new Response(null, { status: 202 })
    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'fixture', version: '1' }
          }
        : request.method === 'tools/list'
          ? { tools: [] }
          : { contents: [] }
    let message: Record<string, unknown> =
      request.method === 'server/discover'
        ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }
        : { jsonrpc: '2.0', id: request.id, result }
    if (request.method !== attack) return Response.json(message)
    sent = true
    if (framing !== 'many') message = { ...message, result: { ...result, padding: payload } }
    if (framing === 'notification')
      message = { jsonrpc: '2.0', method: 'notifications/message', params: { data: payload } }
    if (framing === 'error') message = { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: payload } }
    if (framing === 'late') message.id = 999999
    let body = JSON.stringify(message)
    if (framing === 'sse') body = `data: ${body}\r\n\r\n`
    if (framing === 'comment') body = `: ${payload}`
    if (framing === 'id') body = `id: ${payload}`
    if (framing === 'multiline') body = `data: ${'WIRE_PAYLOAD'.repeat(1000)}\n`.repeat(400)
    if (framing === 'many') body = ': keepalive\r\n\r\n'.repeat(180000) + `data: ${body}\r\n\r\n`
    const bytes = new TextEncoder().encode(body)
    total = bytes.length
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (received === bytes.length) return controller.close()
          const end = Math.min(received + 16384, bytes.length)
          controller.enqueue(bytes.subarray(received, end))
          received = end
        },
        cancel() {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )
    const events = ['sse', 'comment', 'id', 'multiline', 'many'].includes(framing)
    return new Response(stream, {
      status: framing === 'http-error' ? 500 : 200,
      headers: {
        'content-type': events ? 'text/event-stream; charset=utf-8' : 'application/json',
        ...(contentLength ? { 'content-length': String(bytes.length) } : {})
      }
    })
  })
  t.onTestFinished(() => {
    fetch.mockRestore()
    parsing.mockRestore()
  })
  return {
    get received() {
      return received
    },
    get total() {
      return total
    },
    get cancelled() {
      return cancelled
    },
    get sent() {
      return sent
    },
    parsedPayload: () =>
      parsing.mock.calls.some(([text]) => typeof text === 'string' && text.includes('WIRE_PAYLOAD'.repeat(10)))
  }
}

test.for([McpClient, BrowserMcpClient])(
  'HTTP 초기 응답의 Content-Length 초과를 본문 수신 전에 거부한다',
  async (Client, t) => {
    const wire = fixture(t, 'initialize', 'json', true)
    const connection = Client.connect(config)
    const client = await connection.catch(() => undefined)
    if (client) {
      t.onTestFinished(() => client.close())
    }
    expect(wire.sent).toBe(true)
    expect(client === undefined).toBe(true)
    expect(wire.received).toBe(0)
    expect(wire.cancelled).toBe(true)
    expect(wire.received).toBeLessThan(wire.total)
    expect(wire.parsedPayload()).toBe(false)
  }
)

test.for(['initialize', 'server/discover'])('%s의 청크 응답을 JSON 파싱 전에 중단한다', async (method, t) => {
  const wire = fixture(t, method)
  const client = await McpClient.connect(config).catch(() => undefined)
  if (client) t.onTestFinished(() => client.close())
  expect(wire.sent).toBe(true)
  expect(client === undefined).toBe(true)
  expect(wire.cancelled).toBe(true)
  expect(wire.received).toBeLessThan(wire.total)
  expect(wire.parsedPayload()).toBe(false)
})

test.for(['json', 'sse', 'comment', 'id', 'multiline', 'notification', 'error', 'http-error', 'late'])(
  '%s로 받은 연결 이후 응답도 파싱 전에 제한하고 연결을 닫는다',
  async (framing, t) => {
    const wire = fixture(t, 'resources/read', framing)
    const client = await BrowserMcpClient.connect({ ...config, permissions: { resources: '*' } })
    t.onTestFinished(() => client.close())
    await expect(client.readResource('fixture://public')).rejects.toThrow()
    expect(wire.cancelled).toBe(true)
    expect(wire.received).toBeLessThan(wire.total)
    expect(wire.parsedPayload()).toBe(false)
    await expect(client.readResource('fixture://public')).rejects.toThrow(/closed|disconnected/)
  }
)

test.for(['tools/list', 'resources/list', 'resources/templates/list'])(
  '%s의 원시 응답도 SDK 누적 전에 제한한다',
  async (method, t) => {
    const wire = fixture(t, method)
    const client = await McpClient.connect({ ...config, permissions: { tools: '*', resources: '*' } })
    t.onTestFinished(() => client.close())
    const operation =
      method === 'tools/list'
        ? client.tools()
        : method === 'resources/list'
          ? client.listResources()
          : client.listResourceTemplates()
    await expect(operation).rejects.toThrow()
    expect(wire.cancelled).toBe(true)
    expect(wire.received).toBeLessThan(wire.total)
    expect(wire.parsedPayload()).toBe(false)
  }
)

test('GET으로 받은 대용량 SSE 알림도 파싱 전에 제한한다', async (t) => {
  const wire = fixture(t, 'GET', 'sse')
  const client = await BrowserMcpClient.connect(config).catch(() => undefined)
  if (client) t.onTestFinished(() => client.close())
  await expect.poll(() => wire.cancelled).toBe(true)
  expect(wire.parsedPayload()).toBe(false)
  if (client) await expect(client.tools()).rejects.toThrow(/closed|disconnected/)
})

test('작은 SSE 이벤트는 전체 수신량이 한도를 넘어도 계속 처리한다', async (t) => {
  const wire = fixture(t, 'resources/read', 'many')
  const client = await BrowserMcpClient.connect({ ...config, permissions: { resources: '*' } })
  t.onTestFinished(() => client.close())
  await expect(client.readResource('fixture://public')).resolves.toMatchObject({ contents: [] })
  expect(wire.received).toBeGreaterThan(limit)
  expect(wire.cancelled).toBe(false)
})

test('명시적으로 늘린 결과 한도는 원시 응답 한도에도 반영한다', async (t) => {
  const wire = fixture(t, 'resources/read')
  const client = await McpClient.connect({
    ...config,
    permissions: { resources: '*' },
    maxResultBytes: 5 * 1024 * 1024
  })
  t.onTestFinished(() => client.close())
  await expect(client.readResource('fixture://public')).resolves.toMatchObject({ contents: [] })
  expect(wire.received).toBe(wire.total)
  expect(wire.cancelled).toBe(false)
})

test.for(['probe', 'initialize', 'notification'])(
  'stdio의 %s 프레임을 JSON 파싱 전에 제한하고 자식 프로세스를 정리한다',
  async (phase, t) => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-wire-'))
    t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const pids = join(directory, 'pids')
    const parsing = vi.spyOn(JSON, 'parse')
    t.onTestFinished(() => parsing.mockRestore())
    const client = await McpClient.connect({
      serverName: 'stdio',
      transport: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/wire-stdio.ts', import.meta.url)), phase, pids],
      timeoutMs: 1500
    }).catch(() => undefined)
    if (client) {
      t.onTestFinished(() => client.close())
      await client.close()
    }
    if (phase !== 'probe') expect(client === undefined).toBe(true)
    // The SDK may parse a discarded frame's bounded tail while its child is closing.
    expect(parsing.mock.calls.some(([text]) => typeof text === 'string' && text.length > limit)).toBe(false)
    for (const pid of (await readFile(pids, 'utf8')).trim().split('\n').map(Number)) {
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
        .toBe(true)
    }
  }
)
