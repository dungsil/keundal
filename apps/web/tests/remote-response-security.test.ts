import { expect, test } from 'vitest'
import { RemoteChatStore } from '@keundal/plugin-chat-remote'
import { EventType, type AGUIEvent } from '@keundal/core'
import { STREAM_LIMITS } from '@keundal/llm'
import type { LocalChat } from '@keundal/chat/chat-store'

const encoder = new TextEncoder()
const connection = { endpoint: 'https://host.example', token: 'test-token' }
const user = { id: 'user', role: 'user' as const, parts: [{ type: 'text' as const, text: 'question' }] }
const model = 'openai/test'

function bytesResponse(chunks: Uint8Array[], status = 200, headers?: HeadersInit) {
  let cancelled = false
  let reads = 0
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[reads++]
      if (next) controller.enqueue(next)
      else controller.close()
    },
    cancel() { cancelled = true }
  }, { highWaterMark: 0 }), { status, headers })
  return { response, cancelled: () => cancelled, reads: () => reads }
}

const consumers = [
  ['models', (store: RemoteChatStore) => store.models()],
  ['recover', (store: RemoteChatStore) => store.recover()],
  ['catalog', (store: RemoteChatStore) => store.catalog()],
  ['threads', (store: RemoteChatStore) => store.list()],
  ['summaries', (store: RemoteChatStore) => store.listSummaries()],
  ['thread', (store: RemoteChatStore) => store.get('chat')],
  ['run', (store: RemoteChatStore) => store.getRun('run')]
] as const

test.each(consumers)('%s 응답은 선언된 길이가 한도를 넘으면 읽기 전에 취소한다', async (_name, consume) => {
  const body = bytesResponse([encoder.encode('[]')], 200, { 'content-length': String(STREAM_LIMITS.bytes + 1) })
  const store = new RemoteChatStore(connection, async () => body.response)
  await expect(consume(store)).rejects.toThrow(/byte limit/i)
  expect(body.cancelled()).toBe(true)
  expect(body.reads()).toBe(0)
})

test.each([200, 503])('길이 헤더가 없거나 거짓이어도 HTTP %s 본문의 누적 바이트를 제한한다', async status => {
  const size = status === 200 ? STREAM_LIMITS.bytes : 16 * 1024
  const chunk = new Uint8Array(4096).fill(32)
  const body = bytesResponse(Array.from({ length: size / chunk.length + 2 }, () => chunk), status, { 'content-length': '1' })
  const store = new RemoteChatStore(connection, async () => body.response)
  await expect(store.models()).rejects.toThrow(/byte limit/i)
  expect(body.cancelled()).toBe(true)
  expect(body.reads()).toBe(size / chunk.length + 1)
})

test('404 본문은 소비하지 않고 취소하며 정상 오류 본문은 유지한다', async () => {
  const body = bytesResponse([encoder.encode('ignored')], 404)
  expect(await new RemoteChatStore(connection, async () => body.response).get('missing')).toBeUndefined()
  expect(body.cancelled()).toBe(true)
  expect(body.reads()).toBe(0)
  const store = new RemoteChatStore(connection, async () => new Response('host unavailable', { status: 503 }))
  await expect(store.models()).rejects.toThrow('host unavailable')
})

function runFixture(stream: () => Response) {
  let snapshot: { revision: number, state: { web: LocalChat } } = {
    revision: 1,
    state: { web: { id: 'chat', title: 'title', createdAt: '', messages: [user], votes: [], model, started: false, isOwner: true, visibility: 'private' } }
  }
  let subscriptions = 0
  let cancellations = 0
  const store = new RemoteChatStore(connection, async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/cancel')) { cancellations++; return Response.json({ cancelled: true }) }
    if (path === '/models') return Response.json({ models: [{ id: 'test', provider: 'openai', contextWindow: 128000, maxOutputTokens: 4096 }] })
    if (path === '/threads/chat') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        snapshot = { revision: snapshot.revision + 1, state: body.state }
      }
      return Response.json(snapshot)
    }
    if (path === '/runs' || path.endsWith('/events')) { subscriptions++; return stream() }
    throw new Error(`Unexpected request: ${path}`)
  })
  return { store, subscriptions: () => subscriptions, cancellations: () => cancellations }
}

async function collect(store: RemoteChatStore, signal?: AbortSignal) {
  const result: AGUIEvent[] = []
  for await (const event of store.respond('chat', { model, messages: [user] }, signal)) result.push(event)
  return result
}

const frame = (event: AGUIEvent, id = 0) => encoder.encode(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`)

test.each(['unfinished', 'events', 'bytes', 'depth'] as const)('%s 한도 위반 시 원본 스트림과 호스트 실행을 취소한다', async kind => {
  const chunk = new Uint8Array(64 * 1024).fill(32)
  let chunks: Uint8Array[]
  if (kind === 'unfinished') chunks = Array.from({ length: 130 }, () => chunk)
  else if (kind === 'events') chunks = [encoder.encode(': comment\n\n'.repeat(STREAM_LIMITS.events + 1))]
  else if (kind === 'bytes') {
    const comment = encoder.encode(':' + ' '.repeat(1024 * 1024) + '\n\n')
    chunks = Array.from({ length: 33 }, () => comment)
  } else {
    chunks = [encoder.encode('data: {"type":"CUSTOM","name":"deep","value":' + '['.repeat(66) + '0' + ']'.repeat(66) + '}\n\n')]
  }
  const bodies: ReturnType<typeof bytesResponse>[] = []
  const fixture = runFixture(() => {
    const body = bytesResponse(chunks)
    bodies.push(body)
    return body.response
  })
  const events = await collect(fixture.store)
  expect(events).toContainEqual(expect.objectContaining({ type: EventType.RUN_ERROR, message: expect.stringMatching(/limit/i) }))
  expect(events.some(event => event.type === EventType.RUN_FINISHED)).toBe(false)
  expect(fixture.cancellations()).toBe(1)
  // At most one final journal drain, with the same exhausted budget; no retry loop.
  expect(fixture.subscriptions()).toBeLessThanOrEqual(2)
  expect(bodies[0]!.cancelled()).toBe(true)
})

test('재연결한 스트림에도 같은 실행의 누적 프레임 한도를 적용한다', async () => {
  let id = 0
  const fixture = runFixture(() => bytesResponse([
    frame({ type: EventType.CUSTOM, name: 'noop', value: null }, id++),
    encoder.encode(': comment\n\n'.repeat(STREAM_LIMITS.events / 2))
  ]).response)
  const events = await collect(fixture.store)
  expect(events).toContainEqual(expect.objectContaining({ type: EventType.RUN_ERROR, message: expect.stringMatching(/frame limit/i) }))
  expect(fixture.subscriptions()).toBeLessThanOrEqual(3)
})

test('한 바이트씩 나뉜 UTF-8과 CRLF 프레임을 정상 수신한다', async () => {
  const content = [
    { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: '정상 응답' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' },
    { type: EventType.RUN_FINISHED, threadId: 'chat', runId: 'run' }
  ] as AGUIEvent[]
  const bytes = encoder.encode(content.map((event, id) => `id: ${id}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  const fixture = runFixture(() => bytesResponse([...bytes].map(byte => Uint8Array.of(byte))).response)
  const events = await collect(fixture.store)
  expect(events).toEqual(content)
  expect((await fixture.store.get('chat'))!.messages[1]!.parts).toContainEqual({ type: 'text', text: '정상 응답' })
})

test('주입한 fetch가 signal을 무시해도 대기 중인 본문 읽기를 취소한다', async () => {
  const started = Promise.withResolvers<void>()
  let cancelled = false
  const abort = new AbortController()
  const store = new RemoteChatStore(connection, async () => new Response(new ReadableStream({
    pull() { started.resolve() },
    cancel() { cancelled = true }
  })))
  const reading = store.catalog({ signal: abort.signal })
  await started.promise
  abort.abort(new Error('stopped'))
  await expect(reading).rejects.toThrow('stopped')
  expect(cancelled).toBe(true)
})

test('한도 위반 뒤에는 응답을 끝내지 않는 journal 복구 연결을 열지 않는다', async () => {
  let drain: ReadableStreamDefaultController<Uint8Array> | undefined
  let calls = 0
  const fixture = runFixture(() => {
    if (++calls === 1) return bytesResponse([new Uint8Array(STREAM_LIMITS.eventBytes + 1025).fill(32)]).response
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { drain = controller } }))
  })
  const running = collect(fixture.store)
  let timer: ReturnType<typeof setTimeout> | undefined
  const completed = await Promise.race([
    running.then(() => true),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 500) })
  ])
  clearTimeout(timer)
  drain?.close()
  await running
  expect(completed).toBe(true)
  expect(fixture.subscriptions()).toBe(1)
  expect((await fixture.store.get('chat'))!.pendingRunId).toBeUndefined()
})

test('재연결해도 주석 프레임의 누적 바이트 한도를 초기화하지 않는다', async () => {
  const padding = encoder.encode(':' + ' '.repeat(1024 * 1024) + '\n\n')
  const fixture = runFixture(() => bytesResponse(Array.from({ length: 20 }, () => padding)).response)
  const events = await collect(fixture.store)
  expect(events).toContainEqual(expect.objectContaining({ type: EventType.RUN_ERROR, message: expect.stringMatching(/byte limit/i) }))
  expect(fixture.subscriptions()).toBe(2)
  expect(fixture.cancellations()).toBe(1)
})
