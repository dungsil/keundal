import { Buffer } from 'node:buffer'
import { getEventListeners } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { setImmediate } from 'node:timers/promises'

import {
  EventType,
  MessageAssembly,
  parseAGUIEvent,
  type AgentMessage,
  type LLMEvent,
  type LLMRequest
} from '@keundal/core'
import geminiLLMPlugin, { GeminiLLMConfigSchema } from '@keundal/plugin-llm-gemini'
import indexedDBStorePlugin, { type IndexedDBStoreConfig } from '@keundal/plugin-store-indexeddb'
import { Context } from 'cordis'
import { IDBFactory } from 'fake-indexeddb'
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
type Chunk = Record<string, unknown>
type Received = {
  path: string | undefined
  method: string | undefined
  apiKey: string | string[] | undefined
  body: Record<string, unknown>
}
const textChunks: Chunk[] = [
  { responseId: 'resp-1', candidates: [{ content: { role: 'model', parts: [{ text: '안녕' }] } }] },
  { responseId: 'resp-1', candidates: [{ content: { role: 'model', parts: [{ text: '하세요' }] } }] },
  { responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }
]
const wire = (chunks: Chunk[]) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
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
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const received = {
        path: incoming.url,
        method: incoming.method,
        apiKey: incoming.headers['x-goog-api-key'],
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
  const fiber = await ctx.plugin(geminiLLMPlugin, {
    apiKey: 'test-api-key',
    baseURL: `http://127.0.0.1:${address.port}`,
    models: { 'test-model': limits }
  })
  t.onTestFinished(async () => {
    await fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  return { ctx, fiber, requests }
}

test('streamGenerateContent 요청을 보내고 분할된 UTF-8 SSE를 실행 수명 이벤트 없이 변환한다', async (t) => {
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
    { type: EventType.TEXT_MESSAGE_START, messageId: 'resp-1-text-0', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'resp-1-text-0', delta: '안녕' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'resp-1-text-0', delta: '하세요' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'resp-1-text-0' }
  ])
  expect(requests).toStrictEqual([
    {
      path: '/v1beta/models/test-model:streamGenerateContent?alt=sse',
      method: 'POST',
      apiKey: 'test-api-key',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        generationConfig: { maxOutputTokens: 32, thinkingConfig: { includeThoughts: true } }
      }
    }
  ])
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
})

test('생성과 동일하게 변환한 대화와 컨텍스트에 시스템 지침을 합쳐 토큰 수를 계산한다', async (t) => {
  const { ctx, requests } = await setup(t, (incoming, response) => {
    if (incoming.path === '/v1beta/models/test-model:countTokens') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ totalTokens: 73 }))
    } else send(response, [{ responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }])
  })
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
            { type: 'image', source: { type: 'data', value: 'AA==', mimeType: 'image/png' } },
            {
              type: 'image',
              source: { type: 'file', value: 'file_1', provider: 'google', mimeType: 'image/png' }
            }
          ]
        },
        {
          id: 'assistant',
          role: 'assistant',
          content: 'Checking',
          toolCalls: [
            { id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'weather', arguments: '{"city":"Seoul"}' } }
          ]
        },
        { id: 'tool', role: 'tool', toolCallId: 'call_1', content: '{"time":"12:00"}' },
        { id: 'tool-2', role: 'tool', toolCallId: 'call_2', content: 'sunny today' },
        { id: 'rs_1', role: 'reasoning', content: 'summary', encryptedValue: 'opaque-test-value' }
      ]
    }
  }
  const original = globalThis.structuredClone(rich)
  const conversation = [
    { role: 'user', parts: [{ text: '{"context":[{"description":"timezone","value":"Asia/Seoul"}]}' }] },
    {
      role: 'user',
      parts: [
        { text: 'What is shown?' },
        { fileData: { fileUri: 'https://example.com/image.png' } },
        { inlineData: { mimeType: 'image/png', data: 'AA==' } },
        { fileData: { fileUri: 'file_1', mimeType: 'image/png' } }
      ]
    },
    {
      role: 'model',
      parts: [
        { text: 'Checking' },
        { functionCall: { name: 'clock', args: {} } },
        { functionCall: { name: 'weather', args: { city: 'Seoul' } } }
      ]
    },
    { role: 'user', parts: [{ functionResponse: { name: 'clock', response: { time: '12:00' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'weather', response: { output: 'sunny today' } } }] },
    { role: 'model', parts: [{ thought: true, text: 'summary', thoughtSignature: 'opaque-test-value' }] }
  ]
  expect(await ctx.llm.countTokens(rich)).toBe(73)
  await collect(ctx.llm.stream(rich))
  expect(requests[0].path).toBe('/v1beta/models/test-model:countTokens')
  expect(requests[0].body).toStrictEqual({
    contents: [{ role: 'user', parts: [{ text: 'Be concise' }, { text: 'Use tools' }] }, ...conversation]
  })
  expect(requests[1].body).toStrictEqual({
    systemInstruction: { parts: [{ text: 'Be concise' }, { text: 'Use tools' }] },
    contents: conversation,
    generationConfig: { maxOutputTokens: 32, thinkingConfig: { includeThoughts: true } },
    tools: [
      {
        functionDeclarations: [
          { name: 'clock', description: 'Read the time', parametersJsonSchema: { type: 'object', properties: {} } }
        ]
      }
    ]
  })
  expect(rich).toStrictEqual(original)
})

test('각 함수 호출의 시작과 종료 이벤트를 전달하고 도구 호출 ID를 생성한다', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      {
        responseId: 'resp-1',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { name: 'clock', args: {} } },
                { functionCall: { name: 'weather', args: { city: 'Seoul' } } }
              ]
            }
          }
        ]
      },
      { responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }
    ])
  )
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([
    { type: EventType.TOOL_CALL_START, toolCallId: 'resp-1-call-0', toolCallName: 'clock' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'resp-1-call-0', delta: '{}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'resp-1-call-0' },
    { type: EventType.TOOL_CALL_START, toolCallId: 'resp-1-call-1', toolCallName: 'weather' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'resp-1-call-1', delta: '{"city":"Seoul"}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'resp-1-call-1' }
  ])
})

test('함수 호출의 추론 서명을 도구 호출의 암호화된 값으로 전달한다', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      {
        responseId: 'resp-1',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'fc-1', name: 'clock', args: {} }, thoughtSignature: 'sig-1' }]
            }
          }
        ]
      },
      { responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }
    ])
  )
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([
    { type: EventType.TOOL_CALL_START, toolCallId: 'fc-1', toolCallName: 'clock' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'fc-1', delta: '{}' },
    {
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: 'tool-call',
      entityId: 'fc-1',
      encryptedValue: 'sig-1'
    },
    { type: EventType.TOOL_CALL_END, toolCallId: 'fc-1' }
  ])
})

test('추론 요약을 전달하고 추론 메시지를 닫을 때 서명을 전달한다', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      {
        responseId: 'resp-1',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ thought: true, text: 'Thinking', thoughtSignature: 'partial-signature' }]
            }
          }
        ]
      },
      { responseId: 'resp-1', candidates: [{ content: { role: 'model', parts: [{ text: 'Answer' }] } }] },
      { responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }
    ])
  )
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([
    { type: EventType.REASONING_START, messageId: 'resp-1-thought-0' },
    { type: EventType.REASONING_MESSAGE_START, messageId: 'resp-1-thought-0', role: 'reasoning' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'resp-1-thought-0', delta: 'Thinking' },
    {
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: 'message',
      entityId: 'resp-1-thought-0',
      encryptedValue: 'partial-signature'
    },
    { type: EventType.REASONING_MESSAGE_END, messageId: 'resp-1-thought-0' },
    { type: EventType.REASONING_END, messageId: 'resp-1-thought-0' },
    { type: EventType.TEXT_MESSAGE_START, messageId: 'resp-1-text-0', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'resp-1-text-0', delta: 'Answer' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'resp-1-text-0' }
  ])
})

test('일반 텍스트에 붙은 추론 서명과 서명만 있는 후속 항목을 무시한다', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      {
        responseId: 'resp-1',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Answer', thoughtSignature: 'text-signature' }, { thoughtSignature: 'tail-signature' }]
            }
          }
        ]
      },
      { responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }
    ])
  )
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([
    { type: EventType.TEXT_MESSAGE_START, messageId: 'resp-1-text-0', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'resp-1-text-0', delta: 'Answer' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'resp-1-text-0' }
  ])
})

test('메시지 조립 후 텍스트, 생각, 함수 호출 순서를 보존한다', async (t) => {
  let calls = 0
  const { ctx, requests } = await setup(t, (_request, response) =>
    send(
      response,
      calls++ === 0
        ? [
            { responseId: 'resp-1', candidates: [{ content: { role: 'model', parts: [{ text: 'Checking' }] } }] },
            {
              responseId: 'resp-1',
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ thought: true, text: 'Think again', thoughtSignature: 'sig-1' }]
                  }
                }
              ]
            },
            {
              responseId: 'resp-1',
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: { id: 'fc-1', name: 'weather', args: { city: 'Seoul' } },
                        thoughtSignature: 'sig-2'
                      }
                    ]
                  }
                }
              ]
            },
            { responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }
          ]
        : [{ responseId: 'resp-2', candidates: [{ finishReason: 'STOP' }] }]
    )
  )
  const assembly = new MessageAssembly()
  for (const event of await collect(ctx.llm.stream(request))) assembly.apply(event)
  await collect(
    ctx.llm.stream({
      ...request,
      input: {
        ...request.input,
        messages: [
          ...request.input.messages,
          ...assembly.messages,
          { id: 'tool-1', role: 'tool', toolCallId: 'fc-1', content: '{"weather":"Sunny"}' }
        ]
      }
    })
  )
  expect(requests[1].body.contents).toStrictEqual([
    { role: 'user', parts: [{ text: 'Hello' }] },
    { role: 'model', parts: [{ text: 'Checking' }] },
    { role: 'model', parts: [{ thought: true, text: 'Think again', thoughtSignature: 'sig-1' }] },
    {
      role: 'model',
      parts: [{ functionCall: { name: 'weather', args: { city: 'Seoul' } }, thoughtSignature: 'sig-2' }]
    },
    { role: 'user', parts: [{ functionResponse: { name: 'weather', response: { weather: 'Sunny' } } }] }
  ])
})

test('토큰 계산 중 HTTP 오류를 재시도하지 않고 SDK의 상태 코드를 보존한다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 429, message: 'rate limited', status: 'RESOURCE_EXHAUSTED' } }))
  })
  await expect(ctx.llm.countTokens(request)).rejects.toMatchObject({ status: 429 })
  expect(requests).toHaveLength(1)
})

test('저장된 추론 서명과 함수 응답을 생성 요청으로 변환한다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) =>
    send(response, [{ responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }])
  )
  await collect(
    ctx.llm.stream({
      ...request,
      input: {
        ...request.input,
        messages: [
          { id: 'rs_1', role: 'reasoning', content: 'Thinking', encryptedValue: 'sig-1' },
          {
            id: 'msg_1',
            role: 'assistant',
            content: 'Checking',
            toolCalls: [
              { id: 'fc-1', type: 'function', function: { name: 'clock', arguments: '{}' }, encryptedValue: 'sig-2' }
            ]
          },
          { id: 'tool_1', role: 'tool', toolCallId: 'fc-1', content: '{"time":"12:00"}' }
        ]
      }
    })
  )
  expect(requests[0].body).toStrictEqual({
    contents: [
      { role: 'model', parts: [{ thought: true, text: 'Thinking', thoughtSignature: 'sig-1' }] },
      {
        role: 'model',
        parts: [{ text: 'Checking' }, { functionCall: { name: 'clock', args: {} }, thoughtSignature: 'sig-2' }]
      },
      { role: 'user', parts: [{ functionResponse: { name: 'clock', response: { time: '12:00' } } }] }
    ],
    generationConfig: { maxOutputTokens: 32, thinkingConfig: { includeThoughts: true } }
  })
})

test('IndexedDB에 저장한 추론과 도구 호출 서명을 새 Context의 Gemini 요청에 복원한다', async (t) => {
  const storeConfig: IndexedDBStoreConfig = {
    databaseName: 'gemini-signatures',
    indexedDB: new IDBFactory(),
    locks: {
      async request(_name, options, callback) {
        options.signal?.throwIfAborted()
        return callback({})
      }
    }
  }
  const first = await setup(t, (_request, response) =>
    send(response, [
      {
        responseId: 'resp-1',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'Thinking', thoughtSignature: 'reasoning-signature' },
                { text: 'Checking' },
                { functionCall: { id: 'fc-1', name: 'clock', args: {} } },
                {
                  functionCall: { id: 'fc-2', name: 'weather', args: { city: 'Seoul' } },
                  thoughtSignature: 'call-signature'
                }
              ]
            }
          }
        ]
      },
      { responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }
    ])
  )
  const firstStore = await first.ctx.plugin(indexedDBStorePlugin, storeConfig)
  t.onTestFinished(() => firstStore.dispose())
  await first.ctx.session.commit({
    threadId: request.input.threadId,
    expectedRevision: 0,
    messages: request.input.messages,
    state: request.input.state
  })
  const prepared = await first.ctx.session.prepare({ ...request.input, messages: [] })
  const events = await Array.fromAsync(
    first.ctx.generation.run({ ...request, input: prepared.input, sessionRevision: prepared.revision })
  )
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  await firstStore.dispose()
  await first.fiber.dispose()

  const second = await setup(t, (_request, response) =>
    send(response, [{ responseId: 'resp-2', candidates: [{ finishReason: 'STOP' }] }])
  )
  const secondStore = await second.ctx.plugin(indexedDBStorePlugin, storeConfig)
  t.onTestFinished(() => secondStore.dispose())
  const generated: AgentMessage[] = [
    { id: 'resp-1-thought-0', role: 'reasoning', content: 'Thinking', encryptedValue: 'reasoning-signature' },
    {
      id: 'resp-1-text-0',
      role: 'assistant',
      content: 'Checking',
      toolCalls: [
        { id: 'fc-1', type: 'function', function: { name: 'clock', arguments: '{}' } },
        {
          id: 'fc-2',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":"Seoul"}' },
          encryptedValue: 'call-signature'
        }
      ]
    }
  ]
  const results: AgentMessage[] = [
    { id: 'tool-1', role: 'tool', toolCallId: 'fc-1', content: '{"time":"12:00"}' },
    { id: 'tool-2', role: 'tool', toolCallId: 'fc-2', content: '{"temperature":20}' }
  ]
  const restored = await second.ctx.session.prepare({ ...request.input, runId: 'run-2', messages: results })
  expect(restored).toStrictEqual({
    revision: 2,
    input: { ...request.input, runId: 'run-2', messages: [...request.input.messages, ...generated, ...results] }
  })
  const persistedRun = await second.ctx.generation.get(request.input.runId)
  expect(persistedRun?.status).toBe('completed')
  expect(persistedRun?.messages).toStrictEqual(generated)
  expect(persistedRun?.journal.map((entry) => entry.event)).toStrictEqual(events)

  await collect(second.ctx.llm.stream({ ...request, input: restored.input }))
  expect(second.requests).toHaveLength(1)
  expect(second.requests[0].body.contents).toStrictEqual([
    { role: 'user', parts: [{ text: 'Hello' }] },
    { role: 'model', parts: [{ thought: true, text: 'Thinking', thoughtSignature: 'reasoning-signature' }] },
    {
      role: 'model',
      parts: [
        { text: 'Checking' },
        { functionCall: { name: 'clock', args: {} } },
        { functionCall: { name: 'weather', args: { city: 'Seoul' } }, thoughtSignature: 'call-signature' }
      ]
    },
    { role: 'user', parts: [{ functionResponse: { name: 'clock', response: { time: '12:00' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'weather', response: { temperature: 20 } } }] }
  ])
})

const start = { type: EventType.TEXT_MESSAGE_START, messageId: 'resp-1-text-0', role: 'assistant' }
const content = (delta: string) => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'resp-1-text-0', delta })
test.for([
  {
    chunks: [{ responseId: 'resp-1', candidates: [{ finishReason: 'MAX_TOKENS' }] }],
    error: /MAX_TOKENS/,
    received: []
  },
  {
    chunks: [{ responseId: 'resp-1', promptFeedback: { blockReason: 'SAFETY' } }],
    error: /blocked/,
    received: []
  },
  {
    chunks: [{ responseId: 'resp-1', candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] } }] }],
    error: /before a finish reason/,
    received: [start, content('Hi')]
  },
  {
    chunks: [{ responseId: 'resp-1', candidates: [{ index: 1, finishReason: 'STOP' }] }],
    error: /nonzero candidate index/,
    received: []
  },
  {
    chunks: [
      {
        responseId: 'resp-1',
        candidates: [
          {
            finishReason: 'STOP',
            content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] }
          }
        ]
      }
    ],
    error: /unsupported Gemini output part/,
    received: []
  },
  {
    chunks: [
      {
        responseId: 'resp-1',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { name: 'clock', args: {}, partialArgs: [{ jsonPath: '$.city', stringValue: 'Seoul' }] }
                }
              ]
            }
          }
        ]
      }
    ],
    error: /partial function calls/,
    received: []
  },
  {
    chunks: [
      { responseId: 'resp-1', candidates: [{ content: { role: 'model', parts: [{ text: 'a' }] } }] },
      { responseId: 'resp-2', candidates: [{ finishReason: 'STOP' }] }
    ],
    error: /response identifier changed/,
    received: [start, content('a')]
  }
])('실패, 미완료, 차단 또는 내용 불일치가 있는 스트림을 거부한다: $error', async ({ chunks, error, received }, t) => {
  const { ctx } = await setup(t, (_request, response) => send(response, chunks as Chunk[]))
  const collected: LLMEvent[] = []
  const consume = async () => {
    for await (const event of ctx.llm.stream(request)) collected.push(event)
  }
  await expect(consume()).rejects.toThrow(error)
  expect(collected).toStrictEqual(received)
})

test('후보 없이 사용량만 있는 청크를 허용하고 STOP 수신 시 응답을 종료한다', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      { responseId: 'resp-1', usageMetadata: { promptTokenCount: 4 } },
      { responseId: 'resp-1', candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] } }] },
      { responseId: 'resp-1', usageMetadata: { totalTokenCount: 6 }, candidates: [{ finishReason: 'STOP' }] }
    ])
  )
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([
    { type: EventType.TEXT_MESSAGE_START, messageId: 'resp-1-text-0', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'resp-1-text-0', delta: 'Hi' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'resp-1-text-0' }
  ])
})

test('HTTP 오류를 재시도하지 않고 SDK의 상태 코드를 보존한다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 429, message: 'rate limited', status: 'RESOURCE_EXHAUSTED' } }))
  })
  await expect(collect(ctx.llm.stream(request))).rejects.toMatchObject({ status: 429 })
  expect(requests).toHaveLength(1)
})

test('공급자가 반환한 토큰 수가 음수이면 거부한다', async (t) => {
  const { ctx } = await setup(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ totalTokens: -1 }))
  })
  await expect(ctx.llm.countTokens(request)).rejects.toThrow(/invalid Gemini input token count/)
})

test('HTTP 요청 전에 모델 한도, 출력 예산, 지원하지 않는 입력을 검증한다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) =>
    send(response, [{ responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }])
  )
  expect(await ctx.llm.getModel('test-model')).toStrictEqual(limits)
  await expect(ctx.llm.getModel('toString')).rejects.toThrow(/not configured/)
  await expect(ctx.llm.countTokens({ ...request, maxOutputTokens: 65 })).rejects.toThrow(/output budget/)
  await expect(collect(ctx.llm.stream({ ...request, maxOutputTokens: 0 }))).rejects.toThrow(/output budget/)
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
  ).rejects.toThrow(/unsupported Gemini input content: audio/)
  await expect(
    collect(
      ctx.llm.stream({
        ...request,
        input: {
          ...request.input,
          messages: [{ id: 'tool', role: 'tool', toolCallId: 'missing', content: '{}' }]
        }
      })
    )
  ).rejects.toThrow(/no matching tool call/)
  expect(requests).toHaveLength(0)
  expect(
    await GeminiLLMConfigSchema['~standard'].validate({ models: { bad: { contextWindow: 10, maxOutputTokens: 11 } } })
  ).toHaveProperty('issues')
})

test('미리 취소하거나 사용하지 않고 반환한 스트림은 요청을 보내거나 리스너를 남기지 않는다', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) =>
    send(response, [{ responseId: 'resp-1', candidates: [{ finishReason: 'STOP' }] }])
  )
  const external = new globalThis.AbortController()
  const unused = ctx.llm.stream(request, { signal: external.signal })[Symbol.asyncIterator]()
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(1)
  await unused.return!()
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
  const reason = new Error('cancelled before start')
  external.abort(reason)
  await expect(collect(ctx.llm.stream(request, { signal: external.signal }))).rejects.toBe(reason)
  await expect(ctx.llm.countTokens(request, { signal: external.signal })).rejects.toBe(reason)
  expect(requests).toHaveLength(0)
})

test.for(['signal', 'return', 'dispose'] as const)('%s 요청으로 대기 중인 HTTP 스트림을 중단한다', async (mode, t) => {
  const closed = Promise.withResolvers<void>()
  const { ctx, fiber } = await setup(t, (_request, response) => {
    response.on('close', () => closed.resolve())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(
      wire([{ responseId: 'resp-1', candidates: [{ content: { role: 'model', parts: [{ text: '안' }] } }] }])
    )
  })
  const external = new globalThis.AbortController()
  const service = ctx.llm
  const iterator = service.stream(request, { signal: external.signal })[Symbol.asyncIterator]()
  expect((await iterator.next()).value.type).toBe(EventType.TEXT_MESSAGE_START)
  expect((await iterator.next()).value.type).toBe(EventType.TEXT_MESSAGE_CONTENT)
  const pending = iterator.next()
  const rejected = expect(pending).rejects.toThrow(/cancelled|stopped|disposed|aborted/)
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

test('플러그인을 해제하면 응답 헤더를 기다리는 토큰 계산 요청을 취소한다', async (t) => {
  const started = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const { ctx, fiber } = await setup(t, (_request, response) => {
    response.on('close', () => closed.resolve())
    started.resolve()
  })
  const external = new globalThis.AbortController()
  const pending = ctx.llm.countTokens(request, { signal: external.signal })
  const rejected = expect(pending).rejects.toThrow(/disposed/)
  await started.promise
  await fiber.dispose()
  await rejected
  await closed.promise
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
})
