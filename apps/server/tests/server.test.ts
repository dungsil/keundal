import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect } from 'node:net'

import {
  EventType,
  LLMService,
  parseAGUIEvent,
  type AGUIEvent,
  type ExecutionOptions,
  type LLMEvent
} from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-simple'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context, type Fiber } from 'cordis'

const fetch = globalThis.fetch
import { createAgentApp } from '@keundal/server'
import { expect, test, type TestContext } from 'vitest'

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

const setup = async (t: TestContext) => {
  const ctx = new Context()
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 2000, maxOutputTokens: 200 }
    }
    async countTokens() {
      return 10
    }
    stream(): AsyncIterableIterator<LLMEvent> {
      return (async function* () {
        yield* reply
      })()
    }
  }
  const fibers: Fiber[] = [await ctx.plugin(LLM)]
  fibers.push(await ctx.plugin(memoryStorePlugin))
  fibers.push(await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 100 }))

  const app = createAgentApp({
    agent: (run, options?: ExecutionOptions) => ctx.agent.run(run, options),
    session: {
      get: (threadId, options) => ctx.session.get(threadId, options),
      list: (options) => ctx.session.list(options)
    },
    generation: {
      get: (runId, options) => ctx.generation.get(runId, options),
      list: (options) => ctx.generation.list(options),
      recover: (options) => ctx.generation.recover(options)
    }
  })
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
    body?: unknown
  ): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, json: (await response.json()) as unknown }
  }
  const requestText = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; text: string; contentType: string }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get('content-type') ?? ''
    }
  }
  return { base, requestJson, requestText }
}

const parseSse = (text: string): AGUIEvent[] =>
  text
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as AGUIEvent)
    .map((event) => parseAGUIEvent(event))

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
  expect(thread.messages.map((message) => message.id)).toEqual(['reply'])
  const run = (await requestJson('GET', '/runs/r1')).json as { status: string }
  expect(run.status).toBe('completed')
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

test('잘못된 raw request target은 400을 반환하고 서버 프로세스와 후속 정상 요청을 유지한다', async (t) => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { createServer } from 'node:http'
        import { createAgentApp } from ${JSON.stringify(import.meta.resolve('@keundal/server'))}

        const app = createAgentApp({
          agent: async function* () {},
          session: { list: async () => [], get: async () => undefined },
          generation: { list: async () => [], get: async () => undefined, recover: async () => [] }
        })
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

  const rawRequest = (target: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1')
      let response = ''
      socket.setTimeout(2000, () => socket.destroy(new Error('request timed out')))
      socket.on('connect', () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
      })
      socket.on('data', (chunk) => (response += String(chunk)))
      socket.on('end', () => resolve(response))
      socket.on('error', reject)
    })

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
