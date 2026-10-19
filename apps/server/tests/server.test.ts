import { createServer, request as httpRequest } from 'node:http'

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
import { createAgentApp, type AgentAppOptions } from '@keundal/server'
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

const setup = async (t: TestContext, options: AgentAppOptions = {}) => {
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

  let agentCalls = 0
  const app = createAgentApp(
    {
      agent: (run, options?: ExecutionOptions) => {
        agentCalls++
        return ctx.agent.run(run, options)
      },
      session: {
        get: (threadId, options) => ctx.session.get(threadId, options),
        list: (options) => ctx.session.list(options)
      },
      generation: {
        get: (runId, options) => ctx.generation.get(runId, options),
        list: (options) => ctx.generation.list(options),
        recover: (options) => ctx.generation.recover(options)
      }
    },
    options
  )
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
  return {
    base,
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
            headers: transfer === 'chunked' ? { 'transfer-encoding': 'chunked' } : { 'content-length': payload.length }
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
          headers:
            transfer === 'chunked'
              ? { 'transfer-encoding': 'chunked', connection: 'keep-alive' }
              : { 'content-length': '257', connection: 'keep-alive' }
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
