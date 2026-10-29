import { createServer, type Server } from 'node:http'

import { createAgentHost, type AgentHost } from '@keundal/agent-host'
import { createAgentApp } from '@keundal/agent-host/http'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { EventType, parseAGUIEvent } from '@keundal/core'
import { LLMService, type LLMEvent, type LLMRequest } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import { RemoteChatStore } from '@keundal/chat-http'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { expect, onTestFinished, test } from 'vitest'

const token = 'remote-run-token'
const model = 'openai/gpt-5-nano'
const user: ChatMessage = { id: 'user', role: 'user', parts: [{ type: 'text', text: '질문' }] }

type Script = (request: LLMRequest, index: number, signal?: AbortSignal) => AsyncIterable<LLMEvent>

/** 실제 호스트와 HTTP 계층을 띄우고, 제목 요청을 뺀 모델 요청만 기록합니다. */
async function start(script: Script, tools: Parameters<typeof agentPlugin>[1]['tools'] = []) {
  const requests: LLMRequest[] = []
  class ScriptedLLM extends LLMService {
    async getModel() {
      return { contextWindow: 128_000, maxOutputTokens: 4096 }
    }

    async countTokens() {
      return 40
    }

    async* stream(request: LLMRequest, execution?: { signal?: AbortSignal }): AsyncIterable<LLMEvent> {
      if (request.input.messages.some(message => message.role === 'system' && message.content.startsWith('Generate a chat title'))) {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'title', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'title', delta: '제목' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'title' }
        return
      }
      requests.push(request)
      yield* script(request, requests.length - 1, execution?.signal)
    }
  }
  const host: AgentHost = await createAgentHost({
    model: 'gpt-5-nano',
    models: [{ id: 'gpt-5-nano', provider: 'openai', contextWindow: 128_000, maxOutputTokens: 4096 }],
    setup: async (ctx) => {
      await ctx.plugin(ScriptedLLM)
      await ctx.plugin(memoryStorePlugin)
    },
    mountAgent: async (ctx, config) => ctx.plugin(agentPlugin, { ...config, tools })
  })
  const server: Server = createServer(createAgentApp(host.services, { token }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await host.dispose()
  })
  return { host, requests, endpoint: `http://127.0.0.1:${address.port}` }
}

const text = (messageId: string, delta: string): LLMEvent => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta })

test('원격 CHUNK 도구 호출을 한 번 실행하고 역할·metadata와 전체 응답을 세션 및 후속 입력에 보존한다', async () => {
  const executed: unknown[] = []
  const { host, endpoint, requests } = await start(async function* (_request, index) {
    if (index === 0) {
      yield { type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'policy', role: 'developer', delta: 'Check policy', metadata: { policy: true } }
      yield { type: EventType.TOOL_CALL_CHUNK, toolCallId: 'call', toolCallName: 'lookup', delta: '{"city":' }
      yield { type: EventType.TOOL_CALL_CHUNK, delta: '"Seoul"}', metadata: { source: 'chunk' } }
    } else {
      yield { type: EventType.TEXT_MESSAGE_CHUNK, messageId: 'answer', delta: 'All ' }
      yield { type: EventType.TEXT_MESSAGE_CHUNK, delta: 'done', metadata: { finished: true } }
    }
  }, [{ name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } }, execute(args) { executed.push(args); return 'found' } }])
  const store = new RemoteChatStore({ endpoint, token })
  await store.create('chat', user, model)
  const events = await Array.fromAsync(store.respond('chat', { model, messages: [user] }))
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(executed).toEqual([{ city: 'Seoul' }])
  expect(requests).toHaveLength(2)
  expect(requests[1]!.input.messages).toContainEqual({ id: 'policy', role: 'developer', content: 'Check policy', metadata: { policy: true } })
  expect(requests[1]!.input.messages).toContainEqual(expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ id: 'call', metadata: { source: 'chunk' }, function: { name: 'lookup', arguments: '{"city":"Seoul"}' } })] }))
  const saved = (await store.get('chat'))!
  expect(saved.pendingRunId).toBeUndefined()
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', role: 'developer', text: 'Check policy' })
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', text: 'All done' })
  const run = (await host.services.generation.list())[0]!
  expect(run.messages).toContainEqual({ id: 'answer', role: 'assistant', content: 'All done', metadata: { finished: true } })
  expect((await new RemoteChatStore({ endpoint, token }).get('chat'))!.messages).toEqual(saved.messages)
})

/** 첫 응답 본문을 전달한 뒤 연결을 끊고, 재연결 커서를 마지막으로 전달한 id와 비교합니다. */
function droppingFetch(onResume: (value: { url: string, cursor: number }) => void): typeof fetch {
  let dropped = false
  let cursor = -1
  return async (input, init) => {
    const url = String(input)
    const response = await fetch(input, init)
    if (url.includes('/events?')) onResume({ url, cursor })
    if (dropped || !url.endsWith('/runs') || init?.method !== 'POST' || !response.body) return response
    dropped = true
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = ''
    let forwardedText = false
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (forwardedText) {
          void reader.cancel().catch(() => {})
          controller.error(new TypeError('network connection lost'))
          return
        }
        const { done, value } = await reader.read()
        if (done) return controller.close()
        received += decoder.decode(value, { stream: true })
        let boundary = received.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = received.slice(0, boundary).split('\n')
          received = received.slice(boundary + 2)
          const id = frame.find(line => line.startsWith('id: '))
          const data = frame.find(line => line.startsWith('data: '))
          if (id) cursor = Number(id.slice(4))
          if (data && parseAGUIEvent(JSON.parse(data.slice(6))).type === EventType.TEXT_MESSAGE_CONTENT) forwardedText = true
          boundary = received.indexOf('\n\n')
        }
        controller.enqueue(value)
      }
    })
    return new Response(body, { status: response.status, headers: response.headers })
  }
}

test.each([0, 1])('재연결 요청이 %i회 실패해도 afterSequence로 응답을 이어받고 모델을 다시 호출하지 않는다', async (failures) => {
  const resumed = Promise.withResolvers<{ url: string, cursor: number }>()
  const { requests, endpoint } = await start(async function* () {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
    yield text('reply', '앞부분 ')
    // 재연결이 시작된 뒤에 남은 응답을 보내 실시간 구독 경계를 지나게 합니다.
    await resumed.promise
    yield text('reply', '뒷부분')
    yield { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
  })
  const dropped = droppingFetch(value => resumed.resolve(value))
  let attempts = 0
  const store = new RemoteChatStore({ endpoint, token }, (input, init) => {
    if (String(input).includes('/events?') && attempts++ < failures) throw new TypeError('reconnect unavailable')
    return dropped(input, init)
  })
  await store.create('chat', user, model)
  const deltas: string[] = []
  for await (const event of store.respond('chat', { model, messages: [user] })) {
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) deltas.push(event.delta)
  }
  const reconnect = await resumed.promise
  expect(new URL(reconnect.url).searchParams.get('afterSequence')).toBe(String(reconnect.cursor))
  expect(deltas).toEqual(['앞부분 ', '뒷부분'])
  expect(requests).toHaveLength(1)
  const saved = (await store.get('chat'))!
  expect(saved.pendingRunId).toBeUndefined()
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', text: '앞부분 뒷부분' })
})

test('재연결을 소진해도 pendingRunId와 원본 세션을 보존하고 같은 실행의 journal로 전체 응답을 복원한다', async () => {
  const release = Promise.withResolvers<void>()
  onTestFinished(() => release.resolve())
  const { requests, endpoint } = await start(async function* () {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
    yield text('reply', '앞부분 ')
    await release.promise
    yield text('reply', '뒷부분')
    yield { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
  })
  const dropped = droppingFetch(() => {})
  let offline = true
  const store = new RemoteChatStore({ endpoint, token }, (input, init) => {
    if (offline && String(input).includes('/events?')) throw new TypeError('reconnect unavailable')
    return dropped(input, init)
  })
  await store.create('chat', user, model)
  const events = []
  for await (const event of store.respond('chat', { model, messages: [user] })) events.push(event)
  expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR)
  const pending = (await store.get('chat'))!
  expect(pending.pendingRunId).toBeTruthy()
  expect(pending.messages).toEqual([user])
  const queued: ChatMessage = { id: 'queued', role: 'user', parts: [{ type: 'text', text: '다음 질문' }] }
  await store.enqueue('chat', queued)
  expect((await store.get('chat'))!.queue).toEqual([queued])
  release.resolve()
  offline = false
  for await (const _event of store.respond('chat', { model, messages: [user] })) { /* Reuse the host run. */ }
  expect(requests).toHaveLength(1)
  const saved = (await store.get('chat'))!
  expect(saved.pendingRunId).toBeUndefined()
  expect(saved.queue).toEqual([queued])
  expect(saved.messages[1]!.id).toBe(pending.pendingRunId)
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', text: '앞부분 뒷부분' })
})

test('새 클라이언트가 pendingRunId의 journal을 구독하면 모델과 도구를 다시 실행하지 않는다', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let executed = 0
  const { host, requests, endpoint } = await start(async function* (_request, index) {
    if (index === 0) {
      yield { type: EventType.TOOL_CALL_START, toolCallId: 'once', toolCallName: 'work' }
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'once', delta: '{}' }
      yield { type: EventType.TOOL_CALL_END, toolCallId: 'once' }
    } else {
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
      yield text('reply', '완료')
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
    }
  }, [{
    name: 'work', description: 'work', parameters: { type: 'object' },
    async execute() {
      executed++
      entered.resolve()
      await release.promise
      return 'done'
    }
  }])
  let subscriptionFailed = false
  const store = new RemoteChatStore({ endpoint, token }, async (input, init) => {
    if (!subscriptionFailed && String(input).includes('/events?')) {
      subscriptionFailed = true
      throw new TypeError('initial subscription unavailable')
    }
    return fetch(input, init)
  })
  const chat = await store.create('chat', user, model)
  const snapshot = (await host.services.session.get('chat'))!
  const saved = await host.services.session.commit({
    threadId: 'chat', expectedRevision: snapshot.revision, mode: 'replace', messages: snapshot.messages,
    state: { web: { ...chat, started: true, pendingRunId: 'existing-run' } }
  })
  const running = (async () => {
    for await (const _event of host.services.run({
      threadId: 'chat', runId: 'existing-run', state: saved.state, context: [], tools: [],
      messages: [{ id: 'user', role: 'user', content: '질문' }]
    })) { /* The host owns this execution independently of the client. */ }
  })()
  await entered.promise
  const received: ChatMessage[] = []
  for await (const event of store.respond('chat', { model: 'openai/other-selection', messages: [user], onMessage: message => received.push(message) })) {
    if (event.type === EventType.TOOL_CALL_END) release.resolve()
  }
  expect(subscriptionFailed).toBe(true)
  await running
  expect(executed).toBe(1)
  expect(requests).toHaveLength(2)
  expect((await host.services.generation.list()).map(run => run.request.input.runId)).toEqual(['existing-run'])
  expect((await store.get('chat'))!.messages[1]!.parts).toContainEqual({ type: 'text', text: '완료' })
  expect(received.at(-1)?.id).toBe('existing-run')
})

test('원격 중단은 연결 종료와 달리 명시적인 취소로 호스트 실행을 cancelled로 확정한다', async () => {
  const started = Promise.withResolvers<undefined>()
  let aborted = false
  const { host, endpoint } = await start(async function* (_request, _index, signal) {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
    yield text('reply', '부분')
    started.resolve(undefined)
    const halted = Promise.withResolvers<undefined>()
    signal?.addEventListener('abort', () => {
      aborted = true
      halted.reject(signal.reason)
    }, { once: true })
    await halted.promise
  })
  const store = new RemoteChatStore({ endpoint, token })
  await store.create('chat', user, model)
  const running = (async () => {
    for await (const _event of store.respond('chat', { model, messages: [user] })) {
      // 중단될 때까지 소비합니다.
    }
  })()
  await started.promise
  await store.stop()
  await running
  expect(aborted).toBe(true)
  const runs = await host.services.generation.list()
  expect(runs.map(run => run.status)).toEqual(['cancelled'])
  const saved = (await store.get('chat'))!
  expect(saved.pendingRunId).toBeUndefined()
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', text: '부분' })
})

test.each(['http', 'network', 'rejected', 'unfinished'] as const)('취소 응답이 %s이면 중단을 무한히 기다리지 않고 같은 실행을 다시 구독할 수 있다', async (failure) => {
  const release = Promise.withResolvers<void>()
  const { host, endpoint, requests } = await start(async function* () {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
    yield text('reply', '부분 ')
    await release.promise
    yield text('reply', '완료')
    yield { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
  })
  let interrupted = true
  const store = new RemoteChatStore({ endpoint, token }, (input, init) => {
    if (String(input).endsWith('/cancel')) {
      if (failure === 'network') throw new TypeError('cancel unavailable')
      return Promise.resolve(failure === 'http'
        ? new Response('cancel unavailable', { status: 503 })
        : Response.json({ cancelled: failure === 'unfinished' }))
    }
    return fetch(input, init)
  })
  await store.create('chat', user, model)
  const running = (async () => {
    for await (const event of store.respond('chat', { model, messages: [user] })) {
      if (interrupted && event.type === EventType.TEXT_MESSAGE_CONTENT) void store.stop()
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const returned = await Promise.race([
      running.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 6500) })
    ])
    expect(returned).toBe(true)
    const pending = (await store.get('chat'))!
    expect(pending.pendingRunId).toBeTruthy()
    expect((await host.services.generation.list())[0]!.status).toBe('running')
    expect(pending.messages).toEqual([user])
    interrupted = false
    release.resolve()
    for await (const _event of store.respond('chat', { model, messages: [user] })) { /* Resume, do not restart. */ }
    expect(requests).toHaveLength(1)
    expect((await store.get('chat'))!.messages[1]!.parts).toContainEqual({ type: 'text', text: '부분 완료' })
  } finally {
    clearTimeout(timer)
    release.resolve()
    await running
  }
}, 15_000)

test('원격 Steer는 도구 실행 뒤 같은 실행의 다음 요청에 반영되고, 이후 대기열은 정상 종료 뒤 처리할 수 있게 저장된다', async () => {
  const toolStarted = Promise.withResolvers<undefined>()
  const toolRelease = Promise.withResolvers<undefined>()
  let executed = 0
  const { requests, endpoint } = await start(async function* (_request, index) {
    if (index === 0) {
      yield { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'lookup' }
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '{}' }
      yield { type: EventType.TOOL_CALL_END, toolCallId: 'call' }
      return
    }
    yield { type: EventType.TEXT_MESSAGE_START, messageId: `reply-${index}`, role: 'assistant' }
    yield text(`reply-${index}`, '완료')
    yield { type: EventType.TEXT_MESSAGE_END, messageId: `reply-${index}` }
  }, [{
    name: 'lookup',
    description: 'lookup',
    parameters: { type: 'object', properties: {} },
    async execute() {
      executed++
      toolStarted.resolve(undefined)
      await toolRelease.promise
      return 'found'
    }
  }])
  const store = new RemoteChatStore({ endpoint, token })
  await store.create('chat', user, model)
  const running = (async () => {
    for await (const _event of store.respond('chat', { model, messages: [user] })) {
      // 끝까지 소비합니다.
    }
  })()
  await toolStarted.promise
  const steer: ChatMessage = { id: 'steer', role: 'user', parts: [{ type: 'text', text: '표로 정리해' }] }
  const queued: ChatMessage = { id: 'queued', role: 'user', parts: [{ type: 'text', text: '다음 질문' }] }
  expect(await store.steer('chat', steer)).toBe(true)
  expect(await store.enqueue('chat', queued)).toEqual([queued])
  toolRelease.resolve(undefined)
  await running
  expect(executed).toBe(1)
  expect(requests).toHaveLength(2)
  expect(requests[1]!.input.messages.at(-1)).toMatchObject({ id: 'steer', role: 'user' })
  const saved = (await store.get('chat'))!
  expect(saved.messages.map(message => message.id)).toEqual(['user', saved.messages[1]!.id, 'steer'])
  expect(saved.messages[2]!.metadata).toEqual({ steeredRunId: saved.messages[1]!.id })
  expect(saved.queue).toEqual([queued])
  // 실행이 끝난 뒤의 지시는 받지 않으므로 호출자가 대기열로 넘깁니다.
  expect(await store.steer('chat', { ...steer, id: 'late' })).toBe(false)
})
