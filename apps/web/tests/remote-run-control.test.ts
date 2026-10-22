import { createServer, type Server } from 'node:http'

import { createAgentHost, type AgentHost } from '@keundal/agent-host'
import { createAgentApp } from '@keundal/agent-host/http'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { EventType, LLMService, type LLMEvent, type LLMRequest } from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-chat'
import { RemoteChatStore } from '@keundal/plugin-chat-remote'
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

/** 첫 실행 스트림을 SSE 프레임 수만큼 전달한 뒤 네트워크 오류로 끊습니다. */
function droppingFetch(frames: number, onResume: (url: string) => void): typeof fetch {
  let dropped = false
  return async (input, init) => {
    const url = String(input)
    const response = await fetch(input, init)
    if (url.includes('/events?')) onResume(url)
    if (dropped || !url.endsWith('/runs') || init?.method !== 'POST' || !response.body) return response
    dropped = true
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let forwarded = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // 이미 전달한 프레임을 소비자가 읽은 뒤에 끊어야 마지막 커서가 확정됩니다.
        if (forwarded >= frames) {
          void reader.cancel().catch(() => {})
          controller.error(new TypeError('network connection lost'))
          return
        }
        const { done, value } = await reader.read()
        if (done) return controller.close()
        forwarded += decoder.decode(value, { stream: true }).split('\n\n').length - 1
        controller.enqueue(value)
      }
    })
    return new Response(body, { status: response.status, headers: response.headers })
  }
}

test('원격 스트림이 끊기면 afterSequence로 다시 구독해 누락·중복 없이 응답을 이어받고 모델을 다시 호출하지 않는다', async () => {
  const resumed = Promise.withResolvers<string>()
  const { requests, endpoint } = await start(async function* () {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' }
    yield text('reply', '앞부분 ')
    // 재연결이 시작된 뒤에 남은 응답을 보내 실시간 구독 경계를 지나게 합니다.
    await resumed.promise
    yield text('reply', '뒷부분')
    yield { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' }
  })
  const store = new RemoteChatStore({ endpoint, token }, droppingFetch(3, url => resumed.resolve(url)))
  await store.create('chat', user, model)
  const deltas: string[] = []
  for await (const event of store.respond('chat', { model, messages: [user] })) {
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) deltas.push(event.delta)
  }
  expect(await resumed.promise).toContain('afterSequence=2')
  expect(deltas).toEqual(['앞부분 ', '뒷부분'])
  expect(requests).toHaveLength(1)
  const saved = (await store.get('chat'))!
  expect(saved.pendingRunId).toBeUndefined()
  expect(saved.messages[1]!.parts).toContainEqual({ type: 'text', text: '앞부분 뒷부분' })
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
