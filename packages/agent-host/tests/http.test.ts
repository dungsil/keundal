import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, request as httpRequest, type ServerResponse } from 'node:http'
import { connect } from 'node:net'

import { EventType, parseAGUIEvent, type AGUIEvent, type ExecutionOptions } from '@keundal/core'
import { type GenerationSnapshot } from '@keundal/generation'
import { LLMService, type LLMEvent, type LLMRequest } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { MemoryTaskService } from '@keundal/task-memory'
import { ToolApproval, isToolApprovalRecord } from '@keundal/tool-approval'
import { readTraceSpans, TRACE_EVENT } from '@keundal/trace'
import { Context, type Fiber } from 'cordis'

const fetch = globalThis.fetch
import { createAgentApp, type AgentAppOptions, type AgentAppServices } from '@keundal/agent-host/http'
import { expect, test, type TestContext } from 'vitest'

const token = 'test-only-server-token'

const input = {
  threadId: 'thread',
  runId: 'r1',
  state: {},
  tools: [],
  context: [],
  messages: [{ id: 'q1', role: 'user' as const, content: 'hello' }]
}

const reply: LLMEvent[] = [
  { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'hi there' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
]

const setup = async (
  t: TestContext,
  options: Omit<AgentAppOptions, 'token'> = {},
  script?: (request: LLMRequest, options?: ExecutionOptions) => AsyncIterable<LLMEvent>
) => {
  const ctx = new Context()
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 2000, maxOutputTokens: 200 }
    }
    async countTokens() {
      return 10
    }
    stream(request: LLMRequest, execution?: ExecutionOptions): AsyncIterableIterator<LLMEvent> {
      return (async function* () {
        if (script) return yield* script(request, execution)
        yield* reply.map((event) => ({ ...event, messageId: `reply:${request.input.runId}` }))
      })()
    }
  }
  const fibers: Fiber[] = [await ctx.plugin(LLM)]
  fibers.push(await ctx.plugin(memoryStorePlugin))
  fibers.push(await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 100 }))

  let agentCalls = 0
  const services: AgentAppServices = {
    run: (run, options?: ExecutionOptions) => {
      agentCalls++
      return ctx.agent.run(run, options)
    },
    steer: () => 0,
    cancel: () => false,
    subscribe: (runId, options) => ctx.generation.subscribe(runId, options),
    session: {
      get: (threadId, options) => ctx.session.get(threadId, options),
      list: (options) => ctx.session.list(options),
      commit: (change, options) => ctx.session.commit(change, options),
      delete: (threadId, revision, options) => ctx.session.delete(threadId, revision, options)
    },
    generation: {
      get: (runId, options) => ctx.generation.get(runId, options),
      list: (options) => ctx.generation.list(options),
      recover: (options) => ctx.generation.recover(options)
    },
    models: () => [{ id: 'test', provider: 'openai', contextWindow: 2000, maxOutputTokens: 200 }],
    title: async () => 'test title'
  }
  const app = createAgentApp(services, { token, ...options })
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  t.onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    for (const fiber of fibers.toReversed()) await fiber.dispose()
  })
  const base = `http://127.0.0.1:${address.port}`

  const requestJson = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, json: (await response.json()) as unknown }
  }
  const requestText = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; text: string; contentType: string }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get('content-type') ?? ''
    }
  }
  return {
    base,
    server,
    services,
    requestJson,
    requestText,
    get agentCalls() {
      return agentCalls
    }
  }
}

test('승인 API는 인증과 결정을 검증하고 첫 응답만 받아들인다', async (t) => {
  const { services, requestJson } = await setup(t)
  const approval = new ToolApproval()
  services.respondToToolApproval = (runId, requestId, decision) => approval.respond(runId, requestId, decision)
  const abort = new AbortController()
  t.onTestFinished(() => abort.abort())
  let requestId = ''
  const authorized = approval.authorize(
    {
      threadId: 'thread',
      runId: 'r1',
      toolCallId: 'call',
      toolName: 'shell',
      arguments: {},
      operation: { kind: 'shell' }
    },
    abort.signal,
    async (event) => {
      if (isToolApprovalRecord(event.value)) requestId = event.value.requestId
    }
  )
  const path = `/runs/r1/approvals/${requestId}`
  expect((await requestJson('POST', path, { decision: 'allow' }, { authorization: 'Bearer wrong' })).status).toBe(401)
  expect((await requestJson('POST', path, { decision: 'always' })).status).toBe(400)
  expect((await requestJson('POST', path, { decision: 'allow', extra: true })).status).toBe(400)
  expect((await requestJson('POST', `/runs/other/approvals/${requestId}`, { decision: 'allow' })).status).toBe(409)
  expect((await requestJson('POST', path, { decision: 'allow' })).status).toBe(202)
  expect(await authorized).toBe(true)
  expect((await requestJson('POST', path, { decision: 'deny' })).status).toBe(409)
})

const parseFrames = (text: string): { id?: number; event: AGUIEvent }[] =>
  text
    .split('\n\n')
    .filter(Boolean)
    .flatMap((frame) => {
      const lines = frame.split('\n')
      const data = lines.find((line) => line.startsWith('data: '))
      if (!data) return []
      const id = lines.find((line) => line.startsWith('id: '))
      return [
        {
          ...(id ? { id: Number(id.slice(4)) } : {}),
          event: parseAGUIEvent(JSON.parse(data.slice(6)))
        }
      ]
    })

const parseSse = (text: string): AGUIEvent[] => parseFrames(text).map((frame) => frame.event)

test('토큰 설정이 누락되거나 비어 있거나 Bearer 형식이 아니면 앱 생성을 거부한다', async (t) => {
  const { services } = await setup(t)
  for (const options of [
    undefined,
    {},
    { token: '' },
    { token: ' ' },
    { token: 'invalid token' },
    { token: 'token\n' }
  ]) {
    expect(() => Reflect.apply(createAgentApp, undefined, [services, options])).toThrow('HTTP 인증 token')
  }
})

test('모든 경로는 인증 누락과 잘못된 인증을 401로 거부하고 저장된 기록을 보존한다', async (t) => {
  const { base, requestJson, requestText } = await setup(t)
  await requestText('POST', '/runs', input)
  const before = (await requestJson('GET', '/runs')).json

  for (const [method, path] of [
    ['GET', '/threads'],
    ['GET', '/threads/thread'],
    ['GET', '/runs'],
    ['GET', '/runs/r1'],
    ['GET', '/catalog'],
    ['POST', '/runs'],
    ['POST', '/recover'],
    ['GET', '/nope']
  ]) {
    for (const authorization of [
      undefined,
      'Bearer wrong',
      `Bearer ${token.slice(0, -1)}x`,
      `Basic ${token}`,
      `Bearer ${token} extra`
    ]) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: authorization === undefined ? {} : { authorization },
        // 인증 검사가 JSON 파싱이나 실행보다 먼저 이루어져야 합니다.
        body: method === 'POST' ? '{invalid json' : undefined
      })
      expect(response.status, `${method} ${path}`).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({ error: 'unauthorized' })
    }
  }
  expect((await requestJson('GET', '/runs')).json).toEqual(before)
  const response = await fetch(`${base}/threads`, { headers: { authorization: `bearer ${token}` } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual((await requestJson('GET', '/threads')).json)
})

test('POST /runs는 AG-UI 이벤트를 SSE로 스트리밍하고 저장소에 남긴다', async (t) => {
  const { requestJson, requestText } = await setup(t)
  const response = await requestText('POST', '/runs', input)

  expect(response.status).toBe(200)
  expect(response.contentType).toContain('text/event-stream')
  const events = parseSse(response.text)
  expect(
    events.filter((event) => event.type !== EventType.CUSTOM || event.name !== TRACE_EVENT).map((event) => event.type)
  ).toEqual([
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED
  ])

  const thread = (await requestJson('GET', '/threads/thread')).json as { revision: number; messages: { id: string }[] }
  expect(thread.revision).toBe(1)
  expect(thread.messages.map((message) => message.id)).toEqual(['reply:r1'])
  const run = (await requestJson('GET', '/runs/r1')).json as GenerationSnapshot
  expect(run.status).toBe('completed')
  expect(run.journal.map((entry) => entry.event)).toEqual(events)
  expect(readTraceSpans(events, input.runId).map((span) => span.kind)).toEqual(['agent', 'model'])
})

test('GET /catalog는 등록 목록을 반환하며 생성과 대화 저장을 시작하지 않는다', async (t) => {
  const server = await setup(t)
  const catalog = {
    skills: [{ name: 'review', description: 'Review code' }],
    tools: [{ name: 'mcp__docs__tool__search', description: 'Search docs' }]
  }
  server.services.catalog = async () => catalog
  expect(await server.requestJson('GET', '/catalog')).toEqual({ status: 200, json: catalog })
  expect(server.agentCalls).toBe(0)
  expect((await server.requestJson('GET', '/threads')).json).toEqual([])
})

test('POST /runs는 잘못된 입력을 400으로 거부한다', async (t) => {
  const { requestJson } = await setup(t)
  const result = await requestJson('POST', '/runs', { unrelated: true })
  expect(result.status).toBe(400)
  expect((result.json as { error: string }).error).toBe('invalid request')
})

test('GET 조회 경로와 404, recover를 노출한다', async (t) => {
  const { requestJson, requestText } = await setup(t)
  await requestText('POST', '/runs', input)

  const runs = (await requestJson('GET', '/runs')).json as { request: { input: { runId: string } } }[]
  expect(runs.map((snapshot) => snapshot.request.input.runId)).toEqual(['r1'])
  const threads = (await requestJson('GET', '/threads')).json as { threadId: string }[]
  expect(threads.map((snapshot) => snapshot.threadId)).toEqual(['thread'])

  expect((await requestJson('GET', '/runs/missing')).status).toBe(404)
  expect((await requestJson('GET', '/threads/missing')).status).toBe(404)
  expect((await requestJson('GET', '/nope')).status).toBe(404)

  const recovered = await requestJson('POST', '/recover')
  expect(recovered.status).toBe(200)
  // recover는 모든 실행의 스냅숏을 돌리고 미완료 실행만 interrupted로 확정합니다.
  expect((recovered.json as { status: string }[]).map((run) => run.status)).toEqual(['completed'])
})

test.for(['content-length', 'chunked'] as const)(
  '%s 요청은 UTF-8 바이트 상한 이내와 경계값을 허용하고 1바이트 초과는 agent 실행 없이 거부한다',
  async (transfer, t) => {
    const body = JSON.stringify({ ...input, messages: [{ id: 'q1', role: 'user', content: '안녕하세요' }] })
    const limit = Buffer.byteLength(body)
    const app = await setup(t, { maxRequestBodyBytes: limit })

    for (const padding of [-1, 0, 1]) {
      // JSON 끝의 공백으로 유효한 입력을 유지하면서 정확히 limit-1, limit, limit+1 바이트를 만듭니다.
      const payload = Buffer.from(
        body.replace('안녕하세요', '안녕하세').replace('r1', `r${padding + 2}`) + ' '.repeat(3 + padding)
      )
      expect(payload.length).toBe(limit + padding)
      const result = await new Promise<{ status: number; text: string; connection?: string }>((resolve, reject) => {
        const request = httpRequest(
          `${app.base}/runs`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              ...(transfer === 'chunked' ? { 'transfer-encoding': 'chunked' } : { 'content-length': payload.length })
            }
          },
          (response) => {
            let text = ''
            response.setEncoding('utf8')
            response.on('data', (chunk) => {
              text += chunk
            })
            response.on('error', reject)
            response.on('end', () =>
              resolve({ status: response.statusCode!, text, connection: response.headers.connection })
            )
          }
        )
        request.on('error', reject)
        request.write(payload.subarray(0, 50))
        request.end(payload.subarray(50))
      })
      if (padding <= 0) {
        expect(result.status).toBe(200)
        expect(parseSse(result.text).at(-1)?.type).toBe(EventType.RUN_FINISHED)
      } else {
        expect(result.status).toBe(413)
        expect(JSON.parse(result.text)).toEqual({ error: 'request body too large' })
        expect(result.connection).toBe('close')
      }
    }
    expect(app.agentCalls).toBe(2)
    expect((await app.requestJson('GET', '/runs/r1')).status).toBe(200)
  }
)

test.for(['content-length', 'chunked'] as const)(
  '%s 초과 업로드는 본문 종료를 기다리지 않고 413 응답 후 소켓을 닫으며 정상 요청은 계속 처리한다',
  async (transfer, t) => {
    const app = await setup(t, { maxRequestBodyBytes: 256 })
    await new Promise<void>((resolve, reject) => {
      let received = false
      const request = httpRequest(
        `${app.base}/runs`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            ...(transfer === 'chunked'
              ? { 'transfer-encoding': 'chunked', connection: 'keep-alive' }
              : { 'content-length': '257', connection: 'keep-alive' })
          }
        },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            text += chunk
          })
          response.on('error', reject)
          response.on('end', () => {
            try {
              expect(response.statusCode).toBe(413)
              expect(JSON.parse(text)).toEqual({ error: 'request body too large' })
              expect(response.headers.connection).toBe('close')
              received = true
            } catch (error) {
              reject(error)
            }
          })
        }
      )
      request.on('error', reject)
      request.on('socket', (socket) =>
        socket.on('close', () => {
          if (received) resolve()
          else reject(new Error('413 응답 전에 소켓이 닫혔습니다'))
        })
      )
      t.onTestFinished(() => {
        request.destroy()
      })
      request.flushHeaders()
      // Content-Length 사전 검사는 본문 없이, chunked 검사는 종료 청크 없이 거부되어야 합니다.
      if (transfer === 'chunked') {
        request.write(Buffer.alloc(128, ' '))
        request.write(Buffer.alloc(129, ' '))
      }
    })
    expect(app.agentCalls).toBe(0)
    const normal = await app.requestText('POST', '/runs', input)
    expect(normal.status).toBe(200)
    expect(parseSse(normal.text).at(-1)?.type).toBe(EventType.RUN_FINISHED)
    expect(app.agentCalls).toBe(1)
  }
)

test('잘못된 raw request target은 400을 반환하고 서버 프로세스와 후속 정상 요청을 유지한다', async (t) => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { createServer } from 'node:http'
        import { createAgentApp } from ${JSON.stringify(import.meta.resolve('@keundal/agent-host/http'))}

        const app = createAgentApp({
          agent: async function* () {},
          session: { list: async () => [], get: async () => undefined },
          generation: { list: async () => [], get: async () => undefined, recover: async () => [] }
        }, { token: ${JSON.stringify(token)} })
        const server = createServer(app)
        server.listen(0, '127.0.0.1', () => process.send(server.address().port))
      `
    ],
    { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  )
  let stderr = ''
  child.stderr!.on('data', (chunk) => (stderr += String(chunk)))
  const exited = once(child, 'exit')
  t.onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  const [port] = await Promise.race([
    once(child, 'message'),
    exited.then(() => {
      throw new Error(`server exited before listening: ${stderr}`)
    })
  ])

  const rawRequest = (target: string, authenticated = true): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1')
      let response = ''
      socket.setTimeout(2000, () => socket.destroy(new Error('request timed out')))
      socket.on('connect', () => {
        const authorization = authenticated ? `Authorization: Bearer ${token}\r\n` : ''
        socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\n${authorization}Connection: close\r\n\r\n`)
      })
      socket.on('data', (chunk) => (response += String(chunk)))
      socket.on('end', () => resolve(response))
      socket.on('error', reject)
    })

  expect(await rawRequest('//[', false)).toContain('HTTP/1.1 401 Unauthorized')
  expect(await rawRequest('/threads')).toContain('HTTP/1.1 200 OK')
  for (let attempt = 0; attempt < 2; attempt++) {
    const invalid = await rawRequest('//[')
    expect(invalid).toContain('HTTP/1.1 400 Bad Request')
    expect(invalid).toContain('{"error":"invalid request"}')
    const normal = await rawRequest('/threads')
    expect(normal).toContain('HTTP/1.1 200 OK')
    expect(normal).toContain('[]')
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
  }
  expect(stderr).toBe('')
})

test('GET /models는 설정된 모델 한도를 돌려준다', async (t) => {
  const { requestJson } = await setup(t)
  const result = await requestJson('GET', '/models')
  expect(result.status).toBe(200)
  expect(result.json).toEqual({
    models: [{ id: 'test', provider: 'openai', contextWindow: 2000, maxOutputTokens: 200 }]
  })
})

test('POST /runs는 알 수 없는 모델 헤더를 400으로 거부한다', async (t) => {
  const { requestJson, agentCalls } = await setup(t)
  const result = await requestJson('POST', '/runs', input, { 'x-keundal-model': 'missing' })
  expect(result.status).toBe(400)
  expect(result.json).toEqual({ error: 'unknown model: missing' })
  expect(agentCalls).toBe(0)
})

test('PUT /threads/:id와 DELETE /threads/:id는 세션 스냅숏을 저장하고 삭제한다', async (t) => {
  const { base, requestJson } = await setup(t)
  const created = await requestJson('PUT', '/threads/thread', {
    expectedRevision: 0,
    mode: 'replace',
    messages: [{ id: 'q1', role: 'user', content: 'hello' }],
    state: { web: { id: 'thread' } }
  })
  expect(created.status).toBe(200)
  expect(created.json).toMatchObject({ threadId: 'thread', revision: 1, state: { web: { id: 'thread' } } })

  const removed = await fetch(`${base}/threads/thread?revision=1`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` }
  })
  expect(removed.status).toBe(204)
  expect((await requestJson('GET', '/threads/thread')).status).toBe(404)
})

test('POST /title은 제목을 생성한다', async (t) => {
  const { requestJson } = await setup(t)
  const result = await requestJson('POST', '/title', {
    model: 'test',
    message: { id: 'q1', role: 'user', content: 'hello' }
  })
  expect(result.status).toBe(200)
  expect(result.json).toEqual({ title: 'test title' })
})

test('허용한 origin의 preflight에 CORS 헤더를 붙인다', async (t) => {
  const { base } = await setup(t, { allowedOrigins: ['http://tauri.localhost'] })
  const response = await fetch(`${base}/runs`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://tauri.localhost',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type'
    }
  })
  expect(response.status).toBe(204)
  expect(response.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost')
  expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
})

test('허용하지 않은 origin의 preflight는 403으로 거부한다', async (t) => {
  const { base } = await setup(t, { allowedOrigins: ['http://tauri.localhost'] })
  const response = await fetch(`${base}/runs`, {
    method: 'OPTIONS',
    headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' }
  })
  expect(response.status).toBe(403)
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
})

const runStatus = async (base: string, runId: string): Promise<unknown> => {
  const response = await fetch(`${base}/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } })
  const body: unknown = await response.json()
  return typeof body === 'object' && body !== null && 'status' in body ? body.status : undefined
}

test('SSE 연결을 끊어도 실행을 취소하지 않고 afterSequence 재구독이 누락·중복 없이 이어받는다', async (t) => {
  const release = Promise.withResolvers<void>()
  let calls = 0
  const { base, services } = await setup(t, {}, async function* (request) {
    calls++
    const messageId = `reply:${request.input.runId}`
    yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'before' }
    await release.promise
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'after' }
    yield { type: EventType.TEXT_MESSAGE_END, messageId }
  })
  const abort = new AbortController()
  const response = await fetch(`${base}/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: abort.signal
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  while (!parseFrames(received).some((frame) => frame.event.type === EventType.TEXT_MESSAGE_CONTENT)) {
    received += decoder.decode((await reader.read()).value, { stream: true })
  }
  const first = parseFrames(received.slice(0, received.lastIndexOf('\n\n') + 2))
  abort.abort()
  await reader.cancel().catch(() => {})
  expect(await runStatus(base, 'r1')).toBe('running')
  release.resolve()
  const lastId = first.at(-1)!.id!
  const resumed = await fetch(`${base}/runs/r1/events?afterSequence=${lastId}`, {
    headers: { authorization: `Bearer ${token}` }
  })
  const rest = parseFrames(await resumed.text())
  const delivered = [...first, ...rest]
  const journal = (await services.generation.get('r1'))!.journal
  expect(delivered.map((frame) => frame.id)).toEqual(journal.map((entry) => entry.sequence))
  expect(delivered.map((frame) => frame.event)).toEqual(journal.map((entry) => entry.event))
  expect(
    delivered.flatMap((frame) => (frame.event.type === EventType.TEXT_MESSAGE_CONTENT ? [frame.event.delta] : []))
  ).toEqual(['before', 'after'])
  expect(rest.at(-1)?.event.type).toBe(EventType.RUN_FINISHED)
  expect(calls).toBe(1)
  expect(await runStatus(base, 'r1')).toBe('completed')
  const replay = parseFrames(
    await (await fetch(`${base}/runs/r1/events`, { headers: { authorization: `Bearer ${token}` } })).text()
  )
  expect(replay.map((frame) => frame.id)).toEqual(journal.map((entry) => entry.sequence))
  expect(replay.map((frame) => frame.event)).toEqual(journal.map((entry) => entry.event))
  expect(calls).toBe(1)
})

test('없는 실행의 재구독은 404, 잘못된 커서는 400으로 거부한다', async (t) => {
  const { requestJson, requestText } = await setup(t)
  expect((await requestJson('GET', '/runs/missing/events')).status).toBe(404)
  await requestText('POST', '/runs', input)
  expect((await requestJson('GET', '/runs/r1/events?afterSequence=-2')).status).toBe(400)
  expect((await requestJson('GET', '/runs/r1/events?afterSequence=x')).status).toBe(400)
})

test('제목 요청 연결을 중단하면 공급자 호출에 취소 신호를 전달한다', async (t) => {
  const { base, services } = await setup(t)
  let signal: AbortSignal | undefined
  services.title = async (_request, options) => {
    signal = options?.signal
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
    signal!.throwIfAborted()
    return ''
  }
  const abort = new AbortController()
  const request = fetch(`${base}/title`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test', message: input.messages[0] }),
    signal: abort.signal
  }).catch(() => undefined)
  await expect.poll(() => signal).toBeDefined()
  abort.abort()
  await expect.poll(() => signal?.aborted).toBe(true)
  await request
})

test('SSE 쓰기가 막혀도 실행은 끝까지 진행하고 연결을 닫으면 구독만 해제한다', async (t) => {
  let streamed = false
  const { base, server } = await setup(t, {}, async function* (request) {
    yield* reply.map((event) => ({ ...event, messageId: `reply:${request.input.runId}` }))
    streamed = true
  })
  const blocked = Promise.withResolvers<ServerResponse>()
  server.prependListener('request', (request, response) => {
    if (request.method !== 'POST') return
    response.write = (() => {
      blocked.resolve(response)
      return false
    }) as typeof response.write
  })
  const abort = new AbortController()
  const pending = fetch(`${base}/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: abort.signal
  }).catch(() => undefined)
  const response = await blocked.promise
  abort.abort()
  await pending
  await expect.poll(() => runStatus(base, 'r1')).toBe('completed')
  expect(streamed).toBe(true)
  await expect.poll(() => response.listenerCount('drain')).toBe(0)
})

test('SSE 쓰기의 drain을 기다린 뒤 남은 이벤트를 전달한다', async (t) => {
  const { server, requestText } = await setup(t)
  const blocked = Promise.withResolvers<ServerResponse>()
  server.prependListener('request', (request, response) => {
    if (request.method !== 'POST') return
    const write = response.write.bind(response)
    response.write = ((chunk: string) => {
      response.write = write
      blocked.resolve(response)
      write(chunk)
      return false
    }) as typeof response.write
  })
  const pending = requestText('POST', '/runs', input)
  const response = await blocked.promise
  response.emit('drain')
  expect(parseSse((await pending).text).at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(response.listenerCount('drain')).toBe(0)
})

test('큰 이벤트는 직렬화 전에 거부하고 실패를 RUN_ERROR로 전달한다', async (t) => {
  const { base, requestText } = await setup(t, {}, async function* () {
    yield { type: EventType.CUSTOM, name: 'large', value: 'x'.repeat(8 * 1024 * 1024 + 1) }
  })
  const events = parseSse((await requestText('POST', '/runs', input)).text)
  expect(events.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: 'stream byte limit exceeded' })
  expect(events.some((event) => event.type === EventType.CUSTOM && event.name === 'large')).toBe(false)
  expect(await runStatus(base, 'r1')).toBe('failed')
})

test.for(['low', 'medium', 'high'])('%s 추론 수준 헤더를 실행 옵션으로 전달한다', async (reasoning, t) => {
  const { services, requestText } = await setup(t)
  const run = services.run
  let received: unknown
  services.run = (input, options) => {
    received = options
    return run(input, options)
  }
  const response = await requestText('POST', '/runs', input, { 'x-keundal-reasoning': reasoning })
  expect(response.status).toBe(200)
  expect(received).toMatchObject({ reasoning })
})

test('잘못된 추론 수준을 실행 전에 400으로 거부한다', async (t) => {
  const fixture = await setup(t)
  const response = await fixture.requestJson('POST', '/runs', input, { 'x-keundal-reasoning': 'invalid' })
  expect(response.status).toBe(400)
  expect(fixture.agentCalls).toBe(0)
})

test('스레드 요약은 선택한 상태의 원시 값만 반환하고 전체 목록 계약을 유지한다', async (t) => {
  const { requestJson } = await setup(t)
  const state = {
    web: { id: 'thread', title: 'title', createdAt: '2026-10-23', messages: [{ secret: 'private history' }] },
    secret: 'private state'
  }
  await requestJson('PUT', '/threads/thread', { expectedRevision: 0, messages: input.messages, state })
  const summary = await requestJson(
    'GET',
    '/threads?view=summary&stateFields=web.id,web.title,web.createdAt,web.messages,web'
  )
  expect(summary).toEqual({
    status: 200,
    json: [
      { threadId: 'thread', revision: 1, state: { web: { id: 'thread', title: 'title', createdAt: '2026-10-23' } } }
    ]
  })
  expect((await requestJson('GET', '/threads?view=summary')).json).toEqual([
    { threadId: 'thread', revision: 1, state: {} }
  ])
  expect((await requestJson('GET', '/threads')).json).toEqual([
    { threadId: 'thread', revision: 1, messages: input.messages, state }
  ])
  expect((await requestJson('GET', '/threads?view=summary&stateFields=constructor.prototype')).status).toBe(400)
  expect((await requestJson('GET', '/threads?view=unknown')).status).toBe(400)
})

test('호스트는 JSON과 스트림과 인증 오류의 캐시 저장을 금지한다', async (t) => {
  const { base } = await setup(t)
  for (const [path, init] of [
    ['/threads', { headers: { authorization: `Bearer ${token}` } }],
    ['/threads', {}],
    [
      '/runs',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input)
      }
    ]
  ] as const) {
    const response = await fetch(`${base}${path}`, init)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await response.text()
  }
})

test('인증된 작업 API는 부모별 조회와 개별 취소를 제공하고 조회로 실행을 시작하지 않는다', async (t) => {
  const { requestJson, services, base } = await setup(t)
  const ctx = new Context()
  const tasks = new MemoryTaskService(ctx, { maxActive: 1 })
  services.tasks = tasks
  const release = Promise.withResolvers<void>()
  let executions = 0
  try {
    const first = await tasks.enqueue(
      { input, parentThreadId: 'parent-a', parentRunId: 'parent-run' },
      async function* () {
        executions++
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'partial', delta: 'partial result' }
        await release.promise
      }
    )
    const queued = await tasks.enqueue(
      {
        input: { ...input, threadId: 'second', runId: 'second-run' },
        parentThreadId: 'parent-b',
        parentRunId: 'parent-run'
      },
      async function* () {
        executions++
        yield { type: EventType.RUN_FINISHED, threadId: 'second', runId: 'second-run', outcome: { type: 'success' } }
      }
    )
    await expect
      .poll(async () => ((await requestJson('GET', `/tasks/${first.id}`)).json as { content: string }).content)
      .toBe('partial result')
    expect(await requestJson('GET', '/tasks?parentThreadId=parent-b')).toMatchObject({
      status: 200,
      json: [{ id: queued.id, status: 'queued' }]
    })
    expect((await fetch(`${base}/tasks`)).status).toBe(401)
    expect(await requestJson('POST', `/tasks/${queued.id}/cancel`)).toEqual({ status: 200, json: { cancelled: true } })
    expect(await requestJson('POST', `/tasks/${first.id}/cancel`)).toEqual({ status: 200, json: { cancelled: true } })
    expect(await requestJson('GET', `/tasks/${first.id}`)).toMatchObject({
      status: 200,
      json: { status: 'cancelled', content: 'partial result' }
    })
    expect((await requestJson('GET', '/tasks/missing')).status).toBe(404)
    expect(await requestJson('POST', `/tasks/${first.id}/cancel`)).toEqual({ status: 200, json: { cancelled: false } })
    expect(executions).toBe(1)
  } finally {
    release.resolve()
    await tasks.dispose()
  }
})
