import { Buffer } from 'node:buffer'
import { getEventListeners } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { setImmediate } from 'node:timers/promises'

import { EventType, MessageAssembly, parseAGUIEvent, type AgentMessage } from '@keundal/core'
import { type LLMEvent, type LLMRequest } from '@keundal/llm'
import openaiChatLLMPlugin, { OpenAIChatLLMConfigSchema } from '@keundal/plugin-llm-openai-chat'
import { LLM_USAGE_EVENT } from '@keundal/trace'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const request: LLMRequest = {
  model: 'test-model',
  maxOutputTokens: 32,
  input: {
    threadId: 'thread-1',
    runId: 'run-1',
    state: {},
    context: [],
    tools: [],
    messages: [{ id: 'user-1', role: 'user', content: 'Hello' }]
  }
}
const limits = { contextWindow: 128, maxOutputTokens: 64 }
type Chunk = {
  id: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string | null
      refusal?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }
}
type Received = {
  path: string | undefined
  method: string | undefined
  authorization: string | undefined
  body: Record<string, unknown>
}
const chunk = (value: Partial<Chunk> & Pick<Chunk, 'choices'>): Chunk =>
  ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    ...value
  }) as Chunk
const textChunks: Chunk[] = [
  chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '안녕' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { content: '하세요' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
]
const frame = (value: Chunk) => `data: ${JSON.stringify(value)}\n\n`
const wire = (chunks: Chunk[]) => chunks.map(frame).join('') + 'data: [DONE]\n\n'
const send = (response: ServerResponse, chunks: Chunk[]) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(wire(chunks))
}
const collect = async (stream: AsyncIterable<LLMEvent>) => {
  const events: LLMEvent[] = []
  for await (const event of stream) {
    expect(parseAGUIEvent(event)).toStrictEqual(event)
    events.push(event)
  }
  return events
}

async function setup(t: TestContext, handle: (request: Received, response: ServerResponse) => void | Promise<void>) {
  const requests: Received[] = []
  const server = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const part of incoming) chunks.push(Buffer.from(part))
      const received = {
        path: incoming.url,
        method: incoming.method,
        authorization: incoming.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      }
      requests.push(received)
      await handle(received, response)
    })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a port')
  const ctx = new Context()
  const fiber = await ctx.plugin(openaiChatLLMPlugin, {
    apiKey: 'test-api-key',
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    models: { 'test-model': limits }
  })
  t.onTestFinished(async () => {
    await fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  return { ctx, fiber, requests }
}

test('Chat Completions 요청을 보내고 분할된 텍스트를 실행 수명 이벤트 없이 변환한다', async (t) => {
  const { ctx, requests } = await setup(t, async (_request, response) => {
    const bytes = Buffer.from(wire(textChunks))
    const split = bytes.indexOf(Buffer.from('안녕')) + 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(bytes.subarray(0, split))
    await setImmediate()
    response.end(bytes.subarray(split))
  })
  const signal = new globalThis.AbortController().signal
  expect(await collect(ctx.llm.stream(request, { signal }))).toStrictEqual([
    { type: EventType.TEXT_MESSAGE_START, messageId: 'chatcmpl-1', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'chatcmpl-1', delta: '안녕' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'chatcmpl-1', delta: '하세요' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'chatcmpl-1' }
  ])
  expect(requests).toStrictEqual([
    {
      path: '/v1/chat/completions',
      method: 'POST',
      authorization: 'Bearer test-api-key',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 32
      }
    }
  ])
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
})

test('대화, 컨텍스트, 도구와 시스템 메시지를 생성 요청과 동일하게 변환한다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, textChunks))
  const rich: LLMRequest = {
    ...request,
    input: {
      ...request.input,
      state: { privateState: 'not model input' },
      forwardedProps: { model: 'ignored', apiKey: 'ignored' },
      context: [{ description: 'timezone', value: 'Asia/Seoul' }],
      tools: [{ name: 'clock', description: 'Read the time', parameters: { type: 'object', properties: {} } }],
      messages: [
        { id: 'system', role: 'system', content: 'Be concise' },
        { id: 'developer', role: 'developer', content: 'Use tools' },
        {
          id: 'user',
          role: 'user',
          content: [
            { type: 'text', text: 'What is shown?' },
            { type: 'image', source: { type: 'url', value: 'https://example.com/image.png' } },
            { type: 'image', source: { type: 'data', value: 'AA==', mimeType: 'image/png' } }
          ]
        },
        {
          id: 'assistant',
          role: 'assistant',
          content: 'Checking',
          toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } }]
        },
        { id: 'tool', role: 'tool', toolCallId: 'call_1', content: '{"time":"12:00"}' }
      ]
    }
  }
  const original = globalThis.structuredClone(rich)
  await collect(ctx.llm.stream(rich))
  expect(requests[0]!.body.messages).toStrictEqual([
    { role: 'user', content: '{"context":[{"description":"timezone","value":"Asia/Seoul"}]}' },
    { role: 'system', content: 'Be concise' },
    { role: 'developer', content: 'Use tools' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is shown?' },
        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
      ]
    },
    {
      role: 'assistant',
      content: 'Checking',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"time":"12:00"}' }
  ])
  expect(requests[0]!.body.tools).toStrictEqual([
    {
      type: 'function',
      function: { name: 'clock', description: 'Read the time', parameters: { type: 'object', properties: {} } }
    }
  ])
  expect(rich).toStrictEqual(original)
})

test('도구 호출을 변환하고 후속 요청에 인자를 보존한다', async (t) => {
  let calls = 0
  const { ctx, requests } = await setup(t, (_request, response) => {
    if (calls++ === 0) {
      send(response, [
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'clock', arguments: '' } }]
              },
              finish_reason: null
            }
          ]
        }),
        chunk({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"time":' } }] },
              finish_reason: null
            }
          ]
        }),
        chunk({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"12:00"}' } }] },
              finish_reason: null
            }
          ]
        }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      ])
      return
    }
    send(response, textChunks)
  })
  const events = await collect(ctx.llm.stream(request))
  expect(events.filter((event) => event.type === EventType.TOOL_CALL_START)).toStrictEqual([
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: 'call_1',
      toolCallName: 'clock',
      parentMessageId: 'chatcmpl-1'
    }
  ])
  expect(events.filter((event) => event.type === EventType.TOOL_CALL_ARGS)).toStrictEqual([
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call_1', delta: '{"time":' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call_1', delta: '"12:00"}' }
  ])
  expect(events.at(-1)).toStrictEqual({ type: EventType.TOOL_CALL_END, toolCallId: 'call_1' })
  const assembly = new MessageAssembly()
  for (const event of events) assembly.apply(event)
  expect(assembly.messages).toStrictEqual([
    {
      id: 'chatcmpl-1',
      role: 'assistant',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{"time":"12:00"}' } }]
    }
  ])
  await collect(
    ctx.llm.stream({
      ...request,
      input: {
        ...request.input,
        messages: [
          ...request.input.messages,
          ...assembly.messages,
          { id: 'tool-1', role: 'tool', toolCallId: 'call_1', content: 'Sunny' }
        ]
      }
    })
  )
  expect(requests[1]!.body.messages).toStrictEqual([
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{"time":"12:00"}' } }]
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' }
  ])
})

test('추론 강도를 요청에 반영하고 끄면 전송하지 않는다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, textChunks))
  await collect(ctx.llm.stream({ ...request, reasoning: true }))
  expect(requests[0]!.body.reasoning_effort).toBe('medium')
  await collect(ctx.llm.stream({ ...request, reasoning: 'high' }))
  expect(requests[1]!.body.reasoning_effort).toBe('high')
  await collect(ctx.llm.stream({ ...request, reasoning: false }))
  expect(requests[2]!.body.reasoning_effort).toBeUndefined()
})

test('네이티브 검색과 지원하지 않는 입력을 공급자 호출 전에 거부한다', async (t) => {
  const { ctx, requests } = await setup(t, () => {
    throw new Error('unexpected HTTP call')
  })
  await expect(collect(ctx.llm.stream({ ...request, webSearch: true }))).rejects.toThrow(
    /does not support native web search/
  )
  await expect(
    ctx.llm.countTokens({
      ...request,
      input: {
        ...request.input,
        messages: [
          {
            id: 'audio',
            role: 'user',
            content: [{ type: 'audio', source: { type: 'url', value: 'https://example.com/audio.wav' } }]
          }
        ]
      }
    })
  ).rejects.toThrow(/unsupported OpenAI Chat Completions input content: audio/)
  await expect(
    ctx.llm.countTokens({
      ...request,
      input: {
        ...request.input,
        messages: [
          {
            id: 'file',
            role: 'user',
            content: [
              { type: 'image', source: { type: 'file', value: 'file_1', provider: 'openai', mimeType: 'image/png' } }
            ]
          }
        ]
      }
    })
  ).rejects.toThrow(/unsupported OpenAI Chat Completions input content: file/)
  await expect(
    ctx.llm.countTokens({
      ...request,
      input: {
        ...request.input,
        messages: [
          {
            id: 'assistant',
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } }]
          },
          {
            id: 'tool-1',
            role: 'tool',
            toolCallId: 'call_1',
            content: [{ type: 'image', source: { type: 'url', value: 'https://example.com/image.png' } }]
          }
        ]
      }
    })
  ).rejects.toThrow(/unsupported OpenAI Chat Completions tool content: image/)
  expect(requests).toHaveLength(0)
})

test('앞선 도구 호출 없는 도구 결과는 공급자 요청 전에 거부한다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, textChunks))
  const orphan: LLMRequest = {
    ...request,
    input: {
      ...request.input,
      messages: [
        { id: 'q1', role: 'user', content: 'question' },
        { id: 'tool-1', role: 'tool', toolCallId: 'ghost', content: '{}' }
      ]
    }
  }
  await expect(ctx.llm.countTokens(orphan)).rejects.toThrow(/no matching tool call/)
  await expect(collect(ctx.llm.stream(orphan))).rejects.toThrow(/no matching tool call/)
  expect(requests).toEqual([])
})

test('입력 토큰 수를 요청 본문의 UTF-8 바이트 수로 추정한다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, textChunks))
  const candidate: LLMRequest = {
    ...request,
    input: { ...request.input, messages: [{ id: 'user-1', role: 'user', content: '한글😊' }] }
  }
  const expected = Buffer.byteLength(
    '{"model":"test-model","messages":[{"role":"user","content":"한글😊"}],"tools":[]}',
    'utf8'
  )
  expect(await ctx.llm.countTokens(candidate)).toBe(expected)
  expect(await ctx.llm.countTokens(request)).toBeLessThan(expected)
  expect(requests).toHaveLength(0)
})

test('HTTP 요청 전에 모델 한도와 출력 예산을 검증한다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, textChunks))
  expect(await ctx.llm.getModel('test-model')).toStrictEqual(limits)
  await expect(ctx.llm.getModel('toString')).rejects.toThrow(/not configured/)
  await expect(ctx.llm.countTokens({ ...request, maxOutputTokens: 65 })).rejects.toThrow(/output budget/)
  await expect(collect(ctx.llm.stream({ ...request, maxOutputTokens: 0 }))).rejects.toThrow(/output budget/)
  expect(requests).toHaveLength(0)
  expect(
    await OpenAIChatLLMConfigSchema['~standard'].validate({
      models: { bad: { contextWindow: 10, maxOutputTokens: 11 } }
    })
  ).toHaveProperty('issues')
})

test('공급자의 입력·출력 토큰과 캐시 입력 토큰을 기록한다', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      ...textChunks,
      chunk({
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } }
      })
    ])
  )
  const events = await collect(ctx.llm.stream(request))
  expect(events.at(-1)).toEqual({
    type: EventType.CUSTOM,
    name: LLM_USAGE_EVENT,
    value: { source: 'provider', inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 }
  })
})

test.for([
  { reason: 'length', error: /incomplete: length/ },
  { reason: 'content_filter', error: /filtered by the content policy/ }
])('공급자가 $reason 으로 끝내면 응답을 거부한다', async ({ reason, error }, t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '잘림' }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
    ])
  )
  await expect(collect(ctx.llm.stream(request))).rejects.toThrow(error)
})

test('EOF에서도 미완성 도구 호출은 거부하고 열린 텍스트는 종료한다', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking' }, finish_reason: null }] }),
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } }]
            },
            finish_reason: null
          }
        ]
      })
    ])
  )
  await expect(collect(ctx.llm.stream(request))).rejects.toThrow(/unfinished tool calls/)
})

test('EOF에서도 열린 텍스트는 한 번만 종료한다', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking' }, finish_reason: null }] })
    ])
  )
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([
    { type: EventType.TEXT_MESSAGE_START, messageId: 'chatcmpl-1', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'chatcmpl-1', delta: 'Checking' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'chatcmpl-1' }
  ])
})

test('HTTP 오류를 재시도하지 않고 SDK의 상태 코드를 보존한다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate_limit_exceeded' } })
    )
  })
  await expect(collect(ctx.llm.stream(request))).rejects.toMatchObject({ status: 429 })
  expect(requests).toHaveLength(1)
})

test.for(['signal', 'return', 'dispose'] as const)('%s 요청으로 대기 중인 HTTP 스트림을 중단한다', async (mode, t) => {
  const closed = Promise.withResolvers<void>()
  const { ctx, fiber } = await setup(t, (_request, response) => {
    response.on('close', () => closed.resolve())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(
      frame(
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'clock', arguments: '' } }]
              },
              finish_reason: null
            }
          ]
        })
      )
    )
  })
  const external = new globalThis.AbortController()
  const service = ctx.llm
  const iterator = service.stream(request, { signal: external.signal })[Symbol.asyncIterator]()
  expect((await iterator.next()).value.type).toBe(EventType.TOOL_CALL_START)
  const pending = iterator.next()
  const rejected = expect(pending).rejects.toThrow(/cancelled|stopped|disposed/)
  let returned: Promise<IteratorResult<LLMEvent>> | undefined
  if (mode === 'signal') external.abort(new Error('cancelled by caller'))
  else if (mode === 'return') returned = iterator.return!()
  else await fiber.dispose()
  await rejected
  if (returned) expect((await returned).done).toBe(true)
  await closed.promise
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
  if (mode === 'dispose') {
    expect(ctx.llm).toBeUndefined()
    await expect(service.getModel('test-model')).rejects.toThrow(/disposed/)
  }
})

test('저장한 대화를 새 요청에 복원해 어시스턴트 메시지를 그대로 보낸다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, textChunks))
  const generated: AgentMessage = { id: 'chatcmpl-1', role: 'assistant', content: '안녕하세요' }
  await collect(
    ctx.llm.stream({
      ...request,
      input: { ...request.input, messages: [...request.input.messages, generated] }
    })
  )
  expect(requests[0]!.body.messages).toStrictEqual([
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: '안녕하세요' }
  ])
})
