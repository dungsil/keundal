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
import anthropicLLMPlugin, { AnthropicLLMConfigSchema } from '@keundal/plugin-llm-anthropic'
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
type Frame = { type: string; [key: string]: unknown }
type Received = {
  path: string | undefined
  method: string | undefined
  apiKey: string | string[] | undefined
  version: string | string[] | undefined
  body: Record<string, unknown>
}
const start: Frame = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 0 }
  }
}
const stop: Frame = { type: 'message_stop' }
const finish = (reason = 'end_turn'): Frame => ({
  type: 'message_delta',
  delta: { stop_reason: reason, stop_sequence: null },
  usage: { output_tokens: 4 }
})
const blockStart = (index: number, content_block: Record<string, unknown>): Frame => ({
  type: 'content_block_start',
  index,
  content_block
})
const blockDelta = (index: number, delta: Record<string, unknown>): Frame => ({
  type: 'content_block_delta',
  index,
  delta
})
const blockStop = (index: number): Frame => ({ type: 'content_block_stop', index })
const textFrames = [
  start,
  blockStart(0, { type: 'text', text: '' }),
  blockDelta(0, { type: 'text_delta', text: '안녕' }),
  blockDelta(0, { type: 'text_delta', text: '하세요' }),
  blockStop(0),
  finish(),
  stop
]
const wire = (frames: Frame[]) =>
  frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('')
const send = (response: ServerResponse, frames: Frame[]) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(wire(frames))
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
      const received: Received = {
        path: incoming.url,
        method: incoming.method,
        apiKey: incoming.headers['x-api-key'],
        version: incoming.headers['anthropic-version'],
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
  const fiber = await ctx.plugin(anthropicLLMPlugin, {
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

test('sends a Messages request and converts fragmented UTF-8 SSE without run lifecycle events', async (t) => {
  const { ctx, requests } = await setup(t, async (_request, response) => {
    const bytes = Buffer.from(wire(textFrames))
    const split = bytes.indexOf(Buffer.from('안녕')) + 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(bytes.subarray(0, split))
    await setImmediate()
    response.end(bytes.subarray(split))
  })
  const signal = new globalThis.AbortController().signal
  expect(await collect(ctx.llm.stream(request, { signal }))).toStrictEqual([
    { type: EventType.TEXT_MESSAGE_START, messageId: 'msg_1-0', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'msg_1-0', delta: '안녕' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'msg_1-0', delta: '하세요' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'msg_1-0' }
  ])
  expect(requests).toStrictEqual([
    {
      path: '/v1/messages',
      method: 'POST',
      apiKey: 'test-api-key',
      version: '2023-06-01',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        stream: true,
        max_tokens: 32
      }
    }
  ])
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
})

test('counts the same messages, system instructions, tools, context, and images used for generation', async (t) => {
  const { ctx, requests } = await setup(t, (incoming, response) => {
    if (incoming.path === '/v1/messages/count_tokens') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ input_tokens: 73 }))
    } else send(response, [start, finish(), stop])
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
            { type: 'binary', url: 'https://example.com/image.webp', mimeType: 'image/webp' },
            { type: 'binary', data: 'AQ==', mimeType: 'image/jpeg' }
          ]
        },
        {
          id: 'assistant',
          role: 'assistant',
          content: 'Checking',
          toolCalls: [
            { id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'clock', arguments: '{"city":"Seoul"}' } }
          ]
        },
        { id: 'tool-1', role: 'tool', toolCallId: 'call_1', content: '{"time":"12:00"}' },
        { id: 'tool-2', role: 'tool', toolCallId: 'call_2', content: 'unavailable' }
      ]
    }
  }
  const original = globalThis.structuredClone(rich)
  const signal = new globalThis.AbortController().signal
  expect(await ctx.llm.countTokens(rich, { signal })).toBe(73)
  await collect(ctx.llm.stream(rich, { signal }))
  expect(requests[0].path).toBe('/v1/messages/count_tokens')
  expect(requests[0].body).toStrictEqual({
    model: 'test-model',
    system: [
      { type: 'text', text: 'Be concise' },
      { type: 'text', text: 'Use tools' }
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '{"context":[{"description":"timezone","value":"Asia/Seoul"}]}' },
          { type: 'text', text: 'What is shown?' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
          { type: 'image', source: { type: 'base64', data: 'AA==', media_type: 'image/png' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/image.webp' } },
          { type: 'image', source: { type: 'base64', data: 'AQ==', media_type: 'image/jpeg' } }
        ]
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking' },
          { type: 'tool_use', id: 'call_1', name: 'clock', input: {} },
          { type: 'tool_use', id: 'call_2', name: 'clock', input: { city: 'Seoul' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"time":"12:00"}' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'unavailable' }
        ]
      }
    ],
    tools: [{ name: 'clock', description: 'Read the time', input_schema: { type: 'object', properties: {} } }]
  })
  expect(requests[1].body).toStrictEqual({ ...requests[0].body, stream: true, max_tokens: 32 })
  expect(rich).toStrictEqual(original)
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
})

test('streams multiple tool calls with provider IDs and assembles fragmented JSON arguments', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      start,
      blockStart(0, { type: 'tool_use', id: 'call_1', name: 'clock', input: {} }),
      blockDelta(0, { type: 'input_json_delta', partial_json: '{"city":' }),
      blockDelta(0, { type: 'input_json_delta', partial_json: '"Seoul"}' }),
      blockStop(0),
      blockStart(1, { type: 'tool_use', id: 'call_2', name: 'clock', input: {} }),
      blockStop(1),
      finish('tool_use'),
      stop
    ])
  )
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([
    { type: EventType.TOOL_CALL_START, toolCallId: 'call_1', toolCallName: 'clock' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call_1', delta: '{"city":' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call_1', delta: '"Seoul"}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'call_1' },
    { type: EventType.TOOL_CALL_START, toolCallId: 'call_2', toolCallName: 'clock' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call_2', delta: '{}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'call_2' }
  ])
})

test('round-trips signed thinking, redacted thinking, text, and tool calls through message assembly', async (t) => {
  let calls = 0
  const { ctx, requests } = await setup(t, (_request, response) =>
    send(
      response,
      calls++ === 0
        ? [
            start,
            blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
            blockDelta(0, { type: 'thinking_delta', thinking: 'Think' }),
            blockDelta(0, { type: 'thinking_delta', thinking: ' carefully' }),
            blockDelta(0, { type: 'signature_delta', signature: 'draft-signature' }),
            blockDelta(0, { type: 'signature_delta', signature: 'signed-thinking' }),
            blockStop(0),
            blockStart(1, { type: 'redacted_thinking', data: 'opaque-redacted-value' }),
            blockStop(1),
            blockStart(2, { type: 'text', text: '' }),
            blockDelta(2, { type: 'text_delta', text: 'Checking' }),
            blockStop(2),
            blockStart(3, { type: 'tool_use', id: 'call_1', name: 'clock', input: {} }),
            blockDelta(3, { type: 'input_json_delta', partial_json: '{"city":"Seoul"}' }),
            blockStop(3),
            finish('tool_use'),
            stop
          ]
        : [start, finish(), stop]
    )
  )
  const events = await collect(ctx.llm.stream(request))
  expect(events.filter((event) => event.type === EventType.REASONING_ENCRYPTED_VALUE)).toStrictEqual([
    {
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: 'message',
      entityId: 'msg_1-0',
      encryptedValue: '{"provider":"anthropic","type":"thinking","signature":"signed-thinking"}'
    },
    {
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: 'message',
      entityId: 'msg_1-1',
      encryptedValue: '{"provider":"anthropic","type":"redacted_thinking","data":"opaque-redacted-value"}'
    }
  ])
  expect(events.filter((event) => event.type.startsWith('REASONING'))).toStrictEqual([
    { type: EventType.REASONING_START, messageId: 'msg_1-0' },
    { type: EventType.REASONING_MESSAGE_START, messageId: 'msg_1-0', role: 'reasoning' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'msg_1-0', delta: 'Think' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'msg_1-0', delta: ' carefully' },
    {
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: 'message',
      entityId: 'msg_1-0',
      encryptedValue: '{"provider":"anthropic","type":"thinking","signature":"signed-thinking"}'
    },
    { type: EventType.REASONING_MESSAGE_END, messageId: 'msg_1-0' },
    { type: EventType.REASONING_END, messageId: 'msg_1-0' },
    { type: EventType.REASONING_START, messageId: 'msg_1-1' },
    { type: EventType.REASONING_MESSAGE_START, messageId: 'msg_1-1', role: 'reasoning' },
    {
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: 'message',
      entityId: 'msg_1-1',
      encryptedValue: '{"provider":"anthropic","type":"redacted_thinking","data":"opaque-redacted-value"}'
    },
    { type: EventType.REASONING_MESSAGE_END, messageId: 'msg_1-1' },
    { type: EventType.REASONING_END, messageId: 'msg_1-1' }
  ])
  const assembly = new MessageAssembly()
  for (const event of events) assembly.apply(event)
  await collect(
    ctx.llm.stream({
      ...request,
      input: {
        ...request.input,
        messages: [
          ...request.input.messages,
          ...assembly.messages,
          { id: 'tool-result', role: 'tool', toolCallId: 'call_1', content: '12:00' }
        ]
      }
    })
  )
  expect(requests[1].body.messages).toStrictEqual([
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Think carefully', signature: 'signed-thinking' },
        { type: 'redacted_thinking', data: 'opaque-redacted-value' },
        { type: 'text', text: 'Checking' },
        { type: 'tool_use', id: 'call_1', name: 'clock', input: { city: 'Seoul' } }
      ]
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '12:00' }] }
  ])
})

test.for(['text', 'tool_use'] as const)(
  'preserves %s, thinking, tool order after message assembly',
  async (firstType, t) => {
    let calls = 0
    const firstBlock =
      firstType === 'text'
        ? { type: 'text', text: 'Checking first' }
        : { type: 'tool_use', id: 'call_1', name: 'clock', input: { city: 'Seoul' } }
    const { ctx, requests } = await setup(t, (_request, response) =>
      send(
        response,
        calls++ === 0
          ? [
              start,
              blockStart(0, firstBlock),
              blockStop(0),
              blockStart(1, { type: 'thinking', thinking: 'Think again', signature: 'signed-thinking' }),
              blockStop(1),
              blockStart(2, { type: 'tool_use', id: 'call_2', name: 'weather', input: { city: 'Seoul' } }),
              blockStop(2),
              finish('tool_use'),
              stop
            ]
          : [start, finish(), stop]
      )
    )
    const assembly = new MessageAssembly()
    for (const event of await collect(ctx.llm.stream(request))) assembly.apply(event)
    const results: AgentMessage[] = [
      ...(firstType === 'tool_use'
        ? [{ id: 'tool-1', role: 'tool' as const, toolCallId: 'call_1', content: '12:00' }]
        : []),
      { id: 'tool-2', role: 'tool', toolCallId: 'call_2', content: 'Sunny' }
    ]
    await collect(
      ctx.llm.stream({
        ...request,
        input: { ...request.input, messages: [...request.input.messages, ...assembly.messages, ...results] }
      })
    )
    expect(requests[1].body.messages).toStrictEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        content: [
          firstBlock,
          { type: 'thinking', thinking: 'Think again', signature: 'signed-thinking' },
          { type: 'tool_use', id: 'call_2', name: 'weather', input: { city: 'Seoul' } }
        ]
      },
      {
        role: 'user',
        content: [
          ...(firstType === 'tool_use' ? [{ type: 'tool_result', tool_use_id: 'call_1', content: '12:00' }] : []),
          { type: 'tool_result', tool_use_id: 'call_2', content: 'Sunny' }
        ]
      }
    ])
  }
)

test.for(['end_turn', 'tool_use', 'stop_sequence'])('accepts the normal %s stop reason', async (reason, t) => {
  const { ctx } = await setup(t, (_request, response) => send(response, [start, finish(reason), stop]))
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([])
})

test('finishes and closes the HTTP stream after message_stop even if the server keeps it open', async (t) => {
  const closed = Promise.withResolvers<void>()
  const { ctx } = await setup(t, (_request, response) => {
    response.on('close', () => closed.resolve())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(wire([start, { type: 'ping' }, finish(), stop]))
  })
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([])
  await closed.promise
})

test.for([
  { name: 'missing message_stop', frames: [start, finish()] },
  { name: 'missing stop reason', frames: [start, stop] },
  { name: 'max_tokens', frames: [start, finish('max_tokens'), stop] },
  { name: 'pause_turn', frames: [start, finish('pause_turn'), stop] },
  { name: 'unfinished content block', frames: [start, textFrames[1], finish(), stop] },
  { name: 'delta without a block', frames: [start, textFrames[2], finish(), stop] },
  { name: 'duplicate block index', frames: [start, textFrames[1], textFrames[1], finish(), stop] },
  { name: 'stop without a block', frames: [start, blockStop(0), finish(), stop] },
  {
    name: 'wrong delta kind',
    frames: [start, textFrames[1], blockDelta(0, { type: 'thinking_delta', thinking: 'x' })]
  },
  {
    name: 'unsupported block',
    frames: [start, blockStart(0, { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} })]
  },
  {
    name: 'malformed tool JSON',
    frames: [
      start,
      blockStart(0, { type: 'tool_use', id: 'call_1', name: 'clock', input: {} }),
      blockDelta(0, { type: 'input_json_delta', partial_json: '{' }),
      blockStop(0),
      finish('tool_use'),
      stop
    ]
  },
  {
    name: 'non-object tool JSON',
    frames: [
      start,
      blockStart(0, { type: 'tool_use', id: 'call_1', name: 'clock', input: {} }),
      blockDelta(0, { type: 'input_json_delta', partial_json: '[]' }),
      blockStop(0),
      finish('tool_use'),
      stop
    ]
  }
])('rejects incomplete or inconsistent streams: $name', async ({ frames }, t) => {
  const { ctx } = await setup(t, (_request, response) => send(response, frames))
  await expect(collect(ctx.llm.stream(request))).rejects.toThrow()
})

test('preserves partial content when a provider error interrupts the SSE stream', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      ...textFrames.slice(0, 3),
      { type: 'error', error: { type: 'overloaded_error', message: 'provider overloaded' } }
    ])
  )
  const received: LLMEvent[] = []
  const consume = async () => {
    for await (const event of ctx.llm.stream(request)) received.push(event)
  }
  await expect(consume()).rejects.toThrow(/provider overloaded/)
  expect(received).toStrictEqual([
    { type: EventType.TEXT_MESSAGE_START, messageId: 'msg_1-0', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'msg_1-0', delta: '안녕' }
  ])
})

test.for(['stream', 'countTokens'] as const)('preserves SDK HTTP errors without retrying %s', async (operation, t) => {
  const { ctx, requests } = await setup(t, (_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }))
  })
  const signal = new globalThis.AbortController().signal
  const pending =
    operation === 'stream' ? collect(ctx.llm.stream(request, { signal })) : ctx.llm.countTokens(request, { signal })
  await expect(pending).rejects.toMatchObject({ status: 429 })
  expect(requests).toHaveLength(1)
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
})

test.for([-1, 1.5, null, '3', Number.MAX_SAFE_INTEGER + 1])(
  'rejects an invalid input token count: %s',
  async (count, t) => {
    const { ctx } = await setup(t, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ input_tokens: count }))
    })
    await expect(ctx.llm.countTokens(request)).rejects.toThrow(/invalid Anthropic input token count/)
  }
)

test.for([
  null,
  {},
  { models: {} },
  { apiKey: '', models: { model: limits } },
  { baseURL: ' ', models: { model: limits } },
  { models: { model: { contextWindow: 8, maxOutputTokens: 9 } } },
  { models: { model: { contextWindow: 8, maxOutputTokens: 0 } } },
  { models: { model: { contextWindow: 8.5, maxOutputTokens: 4 } } }
])('rejects invalid plugin configuration: %j', async (config) => {
  expect(await AnthropicLLMConfigSchema['~standard'].validate(config)).toHaveProperty('issues')
})

test('validates model limits and output budgets without sending HTTP requests', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, [start, finish(), stop]))
  const model = await ctx.llm.getModel('test-model')
  expect(model).toStrictEqual(limits)
  Object.assign(model, { contextWindow: 1 })
  expect(await ctx.llm.getModel('test-model')).toStrictEqual(limits)
  await expect(ctx.llm.getModel('toString')).rejects.toThrow(/not configured/)
  for (const maxOutputTokens of [0, -1, 65, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(ctx.llm.countTokens({ ...request, maxOutputTokens })).rejects.toThrow(/output budget/)
    await expect(collect(ctx.llm.stream({ ...request, maxOutputTokens }))).rejects.toThrow(/output budget/)
  }
  expect(requests).toHaveLength(0)
})

test.for([
  {
    id: 'audio',
    role: 'user',
    content: [{ type: 'audio', source: { type: 'url', value: 'https://example.com/audio.wav' } }]
  },
  { id: 'file', role: 'user', content: [{ type: 'binary', id: 'file_1', mimeType: 'image/png' }] },
  {
    id: 'svg',
    role: 'user',
    content: [{ type: 'image', source: { type: 'data', value: 'AA==', mimeType: 'image/svg+xml' } }]
  },
  {
    id: 'args',
    role: 'assistant',
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '[]' } }]
  },
  {
    id: 'invalid-json',
    role: 'assistant',
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{' } }]
  },
  { id: 'tool', role: 'tool', toolCallId: 'missing', content: '{}' },
  { id: 'reasoning', role: 'reasoning', content: 'summary', encryptedValue: 'foreign-signature' }
] satisfies AgentMessage[])('rejects unsupported input before HTTP: $id', async (message, t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, [start, finish(), stop]))
  const invalid = { ...request, input: { ...request.input, messages: [message] } }
  await expect(ctx.llm.countTokens(invalid)).rejects.toThrow()
  await expect(collect(ctx.llm.stream(invalid))).rejects.toThrow()
  expect(requests).toHaveLength(0)
})

test('pre-aborted and unused streams do not send requests or retain abort listeners', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, [start, finish(), stop]))
  const external = new globalThis.AbortController()
  const unused = ctx.llm.stream(request, { signal: external.signal })[Symbol.asyncIterator]()
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(1)
  await unused.return!()
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
  const thrown = ctx.llm.stream(request, { signal: external.signal })[Symbol.asyncIterator]()
  const thrownReason = new Error('unused iterator thrown')
  await expect(thrown.throw!(thrownReason)).rejects.toBe(thrownReason)
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
  const reason = new Error('cancelled before start')
  external.abort(reason)
  await expect(collect(ctx.llm.stream(request, { signal: external.signal }))).rejects.toBe(reason)
  await expect(ctx.llm.countTokens(request, { signal: external.signal })).rejects.toBe(reason)
  await expect(ctx.llm.getModel('test-model', { signal: external.signal })).rejects.toBe(reason)
  expect(requests).toHaveLength(0)
})

test.for(['signal', 'return', 'throw', 'dispose'] as const)('aborts pending stream next on %s', async (mode, t) => {
  const closed = Promise.withResolvers<void>()
  const { ctx, fiber } = await setup(t, (_request, response) => {
    response.on('close', () => closed.resolve())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(wire([start, textFrames[1]]))
  })
  const external = new globalThis.AbortController()
  const service = ctx.llm
  const iterator = service.stream(request, { signal: external.signal })[Symbol.asyncIterator]()
  expect((await iterator.next()).value.type).toBe(EventType.TEXT_MESSAGE_START)
  const pending = iterator.next()
  const rejected = expect(pending).rejects.toThrow(/cancelled|stopped|disposed/)
  let returned: Promise<IteratorResult<LLMEvent>> | undefined
  let thrown: Promise<unknown> | undefined
  if (mode === 'signal') external.abort(new Error('cancelled by caller'))
  else if (mode === 'return') returned = iterator.return!()
  else if (mode === 'throw') {
    const reason = new Error('consumer threw')
    thrown = expect(iterator.throw!(reason)).rejects.toBe(reason)
  } else await fiber.dispose()
  await rejected
  if (returned) expect((await returned).done).toBe(true)
  if (thrown) await thrown
  await closed.promise
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
  if (mode === 'dispose') {
    expect(ctx.llm).toBeUndefined()
    await expect(service.getModel('test-model')).rejects.toThrow(/disposed/)
    expect(() => service.stream(request)).toThrow(/disposed/)
    await expect(service.countTokens(request)).rejects.toThrow(/disposed/)
  }
})

test.for([
  { operation: 'stream', mode: 'signal' },
  { operation: 'stream', mode: 'return' },
  { operation: 'stream', mode: 'throw' },
  { operation: 'stream', mode: 'dispose' },
  { operation: 'countTokens', mode: 'signal' },
  { operation: 'countTokens', mode: 'dispose' }
] as const)('cancels $operation before response headers on $mode', async ({ operation, mode }, t) => {
  const started = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const { ctx, fiber } = await setup(t, (_request, response) => {
    response.on('close', () => closed.resolve())
    started.resolve()
  })
  const external = new globalThis.AbortController()
  const iterator =
    operation === 'stream' ? ctx.llm.stream(request, { signal: external.signal })[Symbol.asyncIterator]() : undefined
  const pending = iterator ? iterator.next() : ctx.llm.countTokens(request, { signal: external.signal })
  const rejected = expect(pending).rejects.toThrow(/cancelled|stopped|disposed/)
  await started.promise
  let returned: Promise<IteratorResult<LLMEvent>> | undefined
  let thrown: Promise<unknown> | undefined
  if (mode === 'signal') external.abort(new Error('cancelled before headers'))
  else if (mode === 'return') returned = iterator!.return!()
  else if (mode === 'throw') {
    const reason = new Error('consumer threw before headers')
    thrown = expect(iterator!.throw!(reason)).rejects.toBe(reason)
  } else await fiber.dispose()
  await rejected
  if (returned) expect((await returned).done).toBe(true)
  if (thrown) await thrown
  await closed.promise
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
})
