import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'

import agentPlugin from '@keundal/agent'
import {
  EventType,
  LLMService,
  parseAGUIEvent,
  type AGUIEvent,
  type ExecutionOptions,
  type LLMEvent,
  type LLMRequest
} from '@keundal/core'
import memoryStorePlugin from '@keundal/plugin-store-memory'
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
  messages: [{ id: 'q1', role: 'user', content: 'hello' }]
}

const reply: LLMEvent[] = [
  { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'hi there' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
]

const setup = async (t: TestContext, options: Omit<AgentAppOptions, 'token'> = {}) => {
  const ctx = new Context()
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 2000, maxOutputTokens: 200 }
    }
    async countTokens() {
      return 10
    }
    stream(request: LLMRequest): AsyncIterableIterator<LLMEvent> {
      return (async function* () {
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

const parseSse = (text: string): AGUIEvent[] =>
  text
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as AGUIEvent)
    .map((event) => parseAGUIEvent(event))

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
  expect(events.map((event) => event.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.RUN_FINISHED
  ])

  const thread = (await requestJson('GET', '/threads/thread')).json as { revision: number; messages: { id: string }[] }
  expect(thread.revision).toBe(1)
  expect(thread.messages.map((message) => message.id)).toEqual(['reply:r1'])
  const run = (await requestJson('GET', '/runs/r1')).json as { status: string }
  expect(run.status).toBe('completed')
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

test('SSE 연결을 중단하면 호스트 실행에 취소 신호를 전달한다', async (t) => {
  const { base, services } = await setup(t)
  let signal: AbortSignal | undefined
  services.run = async function* (request, options) {
    signal = options?.signal
    yield { type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId }
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
  }
  const abort = new AbortController()
  const response = await fetch(`${base}/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: abort.signal
  })
  const reader = response.body!.getReader()
  await reader.read()
  abort.abort()
  await expect.poll(() => signal?.aborted).toBe(true)
  reader.releaseLock()
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

test('SSE 쓰기가 막히면 다음 이벤트를 요청하지 않고 연결 종료 때 공급자를 닫는다', async (t) => {
  const { base, server, services } = await setup(t)
  let advanced = false
  let closed = false
  let signal: AbortSignal | undefined
  const blocked = Promise.withResolvers<void>()
  server.prependListener('request', (_request, response) => {
    response.write = (() => {
      blocked.resolve()
      return false
    }) as typeof response.write
  })
  services.run = async function* (_request, options) {
    signal = options?.signal
    try {
      yield { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'r1' }
      advanced = true
      yield { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'r1' }
    } finally {
      closed = true
    }
  }
  const abort = new AbortController()
  const pending = fetch(`${base}/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: abort.signal
  }).catch(() => undefined)
  await blocked.promise
  expect(advanced).toBe(false)
  abort.abort()
  await pending
  await expect.poll(() => closed).toBe(true)
  expect(signal?.aborted).toBe(true)
  expect(advanced).toBe(false)
})

test('SSE 쓰기의 drain을 기다린 뒤 남은 이벤트를 전달한다', async (t) => {
  const { server, services, requestText } = await setup(t)
  let advanced = false
  const blocked = Promise.withResolvers<import('node:http').ServerResponse>()
  server.prependListener('request', (_request, response) => {
    const write = response.write.bind(response)
    response.write = ((chunk: string) => {
      response.write = write
      blocked.resolve(response)
      write(chunk)
      return false
    }) as typeof response.write
  })
  services.run = async function* () {
    yield { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'r1' }
    advanced = true
    yield { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'r1' }
  }
  const pending = requestText('POST', '/runs', input)
  const response = await blocked.promise
  expect(advanced).toBe(false)
  response.emit('drain')
  expect(parseSse((await pending).text).at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(advanced).toBe(true)
  expect(response.listenerCount('drain')).toBe(0)
})

test('큰 SSE 이벤트는 직렬화 전에 거부하고 오류 이벤트만 전달한다', async (t) => {
  const { services, requestText } = await setup(t)
  let closed = false
  services.run = async function* () {
    try {
      yield { type: EventType.CUSTOM, name: 'large', value: 'x'.repeat(8 * 1024 * 1024 + 1) }
    } finally {
      closed = true
    }
  }
  const events = parseSse((await requestText('POST', '/runs', input)).text)
  expect(events).toEqual([{ type: EventType.RUN_ERROR, message: 'stream byte limit exceeded' }])
  expect(closed).toBe(true)
})
