import { Buffer } from 'node:buffer'
import { getEventListeners } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { setImmediate } from 'node:timers/promises'

import { EventType, parseAGUIEvent, type LLMEvent, type LLMRequest } from '@keundal/core'
import openaiLLMPlugin, { OpenAILLMConfigSchema } from '@keundal/plugin-llm-openai'
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
  authorization: string | undefined
  body: Record<string, unknown>
}
const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] }
const completed: Frame = { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } }
const textFrames: Frame[] = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: message },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '안녕' },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '하세요' },
  { type: 'response.output_text.done', item_id: 'msg_1', text: '안녕하세요' },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      ...message,
      status: 'completed',
      content: [{ type: 'output_text', text: '안녕하세요', annotations: [] }]
    }
  },
  completed
]
const wire = (frames: Frame[]) =>
  frames
    .map((frame, sequence_number) => `event: ${frame.type}\ndata: ${JSON.stringify({ ...frame, sequence_number })}\n\n`)
    .join('')
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
  const fiber = await ctx.plugin(openaiLLMPlugin, {
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

test('sends a Responses request and converts fragmented UTF-8 SSE without run lifecycle events', async (t) => {
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
    { type: EventType.TEXT_MESSAGE_START, messageId: 'msg_1', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'msg_1', delta: '안녕' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'msg_1', delta: '하세요' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'msg_1' }
  ])
  expect(requests).toStrictEqual([
    {
      path: '/v1/responses',
      method: 'POST',
      authorization: 'Bearer test-api-key',
      body: {
        model: 'test-model',
        input: [{ role: 'user', content: 'Hello' }],
        tools: [],
        stream: true,
        store: false,
        max_output_tokens: 32,
        truncation: 'disabled',
        include: ['reasoning.encrypted_content']
      }
    }
  ])
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
})

test('counts exactly the same converted conversation, context, and tools that generation sends', async (t) => {
  const { ctx, requests } = await setup(t, (incoming, response) => {
    if (incoming.path === '/v1/responses/input_tokens') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 73 }))
    } else send(response, [completed])
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
            { type: 'binary', id: 'file_1', mimeType: 'image/png' }
          ]
        },
        {
          id: 'assistant',
          role: 'assistant',
          content: 'Checking',
          toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } }]
        },
        { id: 'tool', role: 'tool', toolCallId: 'call_1', content: '{"time":"12:00"}' },
        { id: 'rs_1', role: 'reasoning', content: 'summary', encryptedValue: 'opaque-test-value' }
      ]
    }
  }
  const original = globalThis.structuredClone(rich)
  expect(await ctx.llm.countTokens(rich)).toBe(73)
  await collect(ctx.llm.stream(rich))
  expect(requests[0].path).toBe('/v1/responses/input_tokens')
  expect(requests[0].body).toStrictEqual({
    model: 'test-model',
    input: [
      { role: 'user', content: '{"context":[{"description":"timezone","value":"Asia/Seoul"}]}' },
      { role: 'system', content: 'Be concise' },
      { role: 'developer', content: 'Use tools' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is shown?' },
          { type: 'input_image', detail: 'auto', image_url: 'https://example.com/image.png' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AA==' },
          { type: 'input_image', detail: 'auto', file_id: 'file_1' }
        ]
      },
      { role: 'assistant', content: 'Checking' },
      { type: 'function_call', call_id: 'call_1', name: 'clock', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"time":"12:00"}' },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'summary' }],
        encrypted_content: 'opaque-test-value'
      }
    ],
    tools: [
      {
        type: 'function',
        name: 'clock',
        description: 'Read the time',
        parameters: { type: 'object', properties: {} },
        strict: false
      }
    ]
  })
  expect(requests[1].body).toMatchObject(requests[0].body)
  expect(rich).toStrictEqual(original)
})

test('keeps interleaved function item IDs separate from AG-UI tool call IDs', async (t) => {
  const first = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'clock', arguments: '' }
  const second = { id: 'fc_2', type: 'function_call', call_id: 'call_2', name: 'weather', arguments: '' }
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      { type: 'response.output_item.added', item: first },
      { type: 'response.output_item.added', item: second },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{}' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '"Seoul"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{}' },
      { type: 'response.output_item.done', item: { ...first, arguments: '{}', status: 'completed' } },
      { type: 'response.output_item.done', item: { ...second, arguments: '{"city":"Seoul"}', status: 'completed' } },
      completed
    ])
  )
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([
    { type: EventType.TOOL_CALL_START, toolCallId: 'call_1', toolCallName: 'clock' },
    { type: EventType.TOOL_CALL_START, toolCallId: 'call_2', toolCallName: 'weather' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call_2', delta: '{"city":' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call_1', delta: '{}' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call_2', delta: '"Seoul"}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'call_1' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'call_2' }
  ])
})

test('emits reasoning summaries and only the final encrypted reasoning value', async (t) => {
  const item = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'partial-value' }
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      { type: 'response.output_item.added', item },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Summary' },
      {
        type: 'response.output_item.done',
        item: {
          ...item,
          summary: [{ type: 'summary_text', text: 'Summary' }],
          encrypted_content: 'final-value'
        }
      },
      completed
    ])
  )
  expect(await collect(ctx.llm.stream(request))).toStrictEqual([
    { type: EventType.REASONING_START, messageId: 'rs_1' },
    { type: EventType.REASONING_MESSAGE_START, messageId: 'rs_1', role: 'reasoning' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'rs_1', delta: 'Summary' },
    { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId: 'rs_1', encryptedValue: 'final-value' },
    { type: EventType.REASONING_MESSAGE_END, messageId: 'rs_1' },
    { type: EventType.REASONING_END, messageId: 'rs_1' }
  ])
})

test('streams refusals and fills only missing final text without duplicating deltas', async (t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [
      { type: 'response.output_item.added', item: message },
      { type: 'response.refusal.delta', item_id: 'msg_1', delta: 'Cannot' },
      {
        type: 'response.output_item.done',
        item: { ...message, status: 'completed', content: [{ type: 'refusal', refusal: 'Cannot comply' }] }
      },
      completed
    ])
  )
  const events = await collect(ctx.llm.stream(request))
  expect(
    events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => event.delta)
  ).toStrictEqual(['Cannot', ' comply'])
})

test.for([
  { frame: { type: 'response.failed', response: { error: { message: 'provider failed' } } }, error: /provider failed/ },
  {
    frame: { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    error: /max_output_tokens/
  },
  { frame: { type: 'error', code: 'server_error', message: 'stream error', param: null }, error: /stream error/ },
  { frame: undefined, error: /before response.completed/ }
])('rejects failed, incomplete, error, or truncated streams: $error', async ({ frame, error }, t) => {
  const { ctx } = await setup(t, (_request, response) =>
    send(response, [textFrames[1], textFrames[2], ...(frame ? [frame] : [])])
  )
  const received: LLMEvent[] = []
  const consume = async () => {
    for await (const event of ctx.llm.stream(request)) received.push(event)
  }
  await expect(consume()).rejects.toThrow(error)
  expect(received.map((event) => event.type)).toStrictEqual([
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT
  ])
})

test('does not retry HTTP failures or hide the SDK status code', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate_limit_exceeded' } })
    )
  })
  await expect(collect(ctx.llm.stream(request))).rejects.toMatchObject({ status: 429 })
  expect(requests).toHaveLength(1)
})

test('preserves assistant phase metadata when replaying an OpenAI message', async (t) => {
  const item = { ...message, phase: 'commentary' }
  const { ctx, requests } = await setup(t, (_request, response) =>
    send(response, [
      { type: 'response.output_item.added', item },
      {
        type: 'response.output_item.done',
        item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'Checking', annotations: [] }] }
      },
      completed
    ])
  )
  const events = await collect(ctx.llm.stream(request))
  expect(events[0].metadata).toStrictEqual({ 'openai.phase': 'commentary' })
  expect(events.at(-1)?.metadata).toStrictEqual({ 'openai.phase': 'commentary' })
  await collect(
    ctx.llm.stream({
      ...request,
      input: {
        ...request.input,
        messages: [{ id: 'msg_1', role: 'assistant', content: 'Checking', metadata: events[0].metadata }]
      }
    })
  )
  expect(requests[1].body.input).toStrictEqual([
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'Checking', annotations: [] }]
    }
  ])
})

test.for([
  { frames: [textFrames[1], completed], error: /unfinished output items/ },
  { frames: [textFrames[2], completed], error: /no matching output item/ },
  {
    frames: [
      textFrames[1],
      textFrames[2],
      {
        type: 'response.output_item.done',
        item: {
          ...message,
          status: 'completed',
          content: [{ type: 'output_text', text: 'different', annotations: [] }]
        }
      },
      completed
    ],
    error: /differs from streamed content/
  }
])('rejects inconsistent provider event sequences: $error', async ({ frames, error }, t) => {
  const { ctx } = await setup(t, (_request, response) => send(response, frames))
  await expect(collect(ctx.llm.stream(request))).rejects.toThrow(error)
})

test('rejects invalid token counts instead of treating them as available context', async (t) => {
  const { ctx } = await setup(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: -1 }))
  })
  await expect(ctx.llm.countTokens(request)).rejects.toThrow(/invalid OpenAI input token count/)
})

test('validates model limits, budgets, and unsupported input before any HTTP request', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, [completed]))
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
  ).rejects.toThrow(/unsupported OpenAI input content: audio/)
  expect(requests).toHaveLength(0)
  expect(
    await OpenAILLMConfigSchema['~standard'].validate({ models: { bad: { contextWindow: 10, maxOutputTokens: 11 } } })
  ).toHaveProperty('issues')
})

test('pre-aborted and unused streams do not send requests or retain listeners', async (t) => {
  const { ctx, requests } = await setup(t, (_request, response) => send(response, [completed]))
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

test.for(['signal', 'return', 'dispose'] as const)('aborts a blocked HTTP stream on %s', async (mode, t) => {
  const closed = Promise.withResolvers<void>()
  const { ctx, fiber } = await setup(t, (_request, response) => {
    response.on('close', () => closed.resolve())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(wire([textFrames[1]]))
  })
  const external = new globalThis.AbortController()
  const service = ctx.llm
  const iterator = service.stream(request, { signal: external.signal })[Symbol.asyncIterator]()
  expect((await iterator.next()).value.type).toBe(EventType.TEXT_MESSAGE_START)
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

test('disposal cancels a pending token-count request before response headers', async (t) => {
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
