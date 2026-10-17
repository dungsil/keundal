import { Buffer } from 'node:buffer'
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http'
import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from 'ai'
import { expect, test, onTestFinished } from 'vitest'
import { Context } from 'cordis'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { browserLLMPlugin } from '../shared/utils/browser-llm'
import { createKeundalChat as createChat } from '../shared/utils/keundal'
import { ChatStore } from '../shared/utils/chat-store'
import { defaultLLMSettings } from '../shared/utils/llm-settings'

async function createKeundalChat(name: string, options: { webSearch?: boolean, reasoning?: boolean }, env: Record<string, string>) {
  const ctx = new Context()
  const llm = ctx.plugin(browserLLMPlugin, { getSettings: () => ({
    openai: { apiKey: env.OPENAI_API_KEY ?? '', baseURL: env.OPENAI_BASE_URL ?? '' },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY ?? '', baseURL: env.ANTHROPIC_BASE_URL ?? '' },
    google: { apiKey: env.GEMINI_API_KEY ?? '', baseURL: env.GEMINI_BASE_URL ?? '' }
  }) })
  await llm
  const store = ctx.plugin(memoryStorePlugin)
  await store
  onTestFinished(async () => {
    await store.dispose()
    await llm.dispose()
  })
  return createChat(ctx, name, options)
}

type Frame = Record<string, unknown>
const user: UIMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '서울 날씨' }, { type: 'file', url: 'data:image/png;base64,iVBORw==', mediaType: 'image/png' }] }

function openaiText(text: string): Frame[] {
  const item = { id: 'msg_answer', type: 'message', role: 'assistant', content: [] }
  return [
    { type: 'response.output_item.added', item },
    { type: 'response.output_text.delta', item_id: item.id, delta: text },
    { type: 'response.output_item.done', item: { ...item, content: [{ type: 'output_text', text, annotations: [] }] } },
    { type: 'response.completed', response: { status: 'completed' } }
  ]
}

function anthropicText(text: string): Frame[] {
  return [
    { type: 'message_start', message: { id: 'anthropic-answer', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' }
  ]
}

function send(response: ServerResponse, frames: Frame[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(frames.map(frame => `${frame.type ? `event: ${frame.type}\n` : ''}data: ${JSON.stringify(frame)}\n\n`).join(''))
}

async function setup(handle: (body: Record<string, unknown>, response: ServerResponse, request: IncomingMessage) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (/input_tokens|count_tokens|:countTokens/.test(request.url ?? '')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ input_tokens: 15, totalTokens: 15 }))
      return
    }
    handle(JSON.parse(Buffer.concat(chunks).toString()), response, request)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  return `http://127.0.0.1:${address.port}`
}

// Exercise the unchanged template client's real SSE decoder, not just our encoder.
async function decode(response: Response, onChunk?: (chunk: UIMessageChunk) => void) {
  const transport = new DefaultChatTransport({ fetch: async () => response })
  const stream = await transport.sendMessages({ trigger: 'submit-message', chatId: 'chat', messageId: undefined, messages: [user], abortSignal: undefined })
  const chunks: UIMessageChunk[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    onChunk?.(chunk)
  }
  return chunks
}

test.each([
  { name: 'openai/gpt-5-nano', key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL', id: 'gpt-5-nano', frames: openaiText('서울은 맑아요') },
  { name: 'anthropic/claude-haiku-4.5', key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL', id: 'claude-haiku-4-5', frames: anthropicText('서울은 맑아요') },
  { name: 'google/gemini-3-flash', key: 'GEMINI_API_KEY', url: 'GEMINI_BASE_URL', id: 'gemini-3-flash-preview', frames: [{ responseId: 'gemini-answer', candidates: [{ content: { role: 'model', parts: [{ text: '서울은 맑아요' }] }, finishReason: 'STOP' }] }] }
])('$name: 제목과 이미지 대화를 Keundal로 실행하고 원본 클라이언트 스트림으로 저장한다', async ({ name, key, url, id, frames }) => {
  const received: Record<string, unknown>[] = []
  const baseURL = await setup((body, response) => {
    received.push(body)
    send(response, frames)
  })
  const chat = await createKeundalChat(name, { reasoning: false }, { [key]: 'local-test-key', [url]: baseURL })
  onTestFinished(chat.dispose)
  expect(await chat.title(user)).toBe('서울은 맑아요')
  let saved: UIMessage | undefined
  const chunks = await decode(chat.respond({ threadId: 'chat', messages: [user], instructions: '도움말', onFinish: async (message) => {
    saved = message
  } }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: '서울은 맑아요' }))
  expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' })
  expect(saved?.parts).toContainEqual({ type: 'text', text: '서울은 맑아요' })
  expect(received).toHaveLength(2)
  expect(JSON.stringify(received[1])).toContain('iVBORw==')
  expect(JSON.stringify(received[1])).toContain('image/png')
  if (key !== 'GEMINI_API_KEY') expect(received.every(body => body.model === id)).toBe(true)
  if (key === 'OPENAI_API_KEY') expect(received[1]!.reasoning).toEqual({ effort: 'minimal' })
  if (key === 'GEMINI_API_KEY') expect(received[1]!.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: false } })
})

test('검색 출처와 추론 암호문을 보존하고 chart 실행과 새 요청의 후속 대화를 Keundal로 수행한다', async () => {
  const requests: Record<string, unknown>[] = []
  const reasoning = { id: 'rs_original', type: 'reasoning', summary: [{ type: 'summary_text', text: '추세를 확인합니다' }], encrypted_content: 'opaque-reasoning' }
  const search = { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: '추세' } }
  const args = { data: [{ month: 'Jan', sales: 17 }, { month: 'Feb', sales: 32 }], xKey: 'month', series: [{ key: 'sales', name: 'Sales', color: '#3b82f6' }] }
  const call = { id: 'fc_original', type: 'function_call', call_id: 'call_chart', name: 'chart', arguments: JSON.stringify(args) }
  const baseURL = await setup((body, response) => {
    requests.push(body)
    if (requests.length > 1) return send(response, openaiText('2월은 32입니다'))
    send(response, [
      ...[search, reasoning].flatMap(item => [{ type: 'response.output_item.added', item }, { type: 'response.output_item.done', item }]),
      { type: 'response.output_item.added', item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: call.arguments.slice(0, 20) },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: call.arguments.slice(20) },
      { type: 'response.output_item.done', item: call },
      ...openaiText('출처를 확인했습니다').map(frame => frame.type === 'response.output_item.done'
        ? { ...frame, item: { ...(frame.item as Frame), content: [{ type: 'output_text', text: '출처를 확인했습니다', annotations: [{ type: 'url_citation', url: 'https://example.com/trends', title: 'Trends', start_index: 0, end_index: 2 }] }] } }
        : frame)
    ])
  })
  const env = { OPENAI_API_KEY: 'local-test-key', OPENAI_BASE_URL: baseURL }
  const chat = await createKeundalChat('openai/gpt-5-nano', { webSearch: true, reasoning: true }, env)
  onTestFinished(chat.dispose)
  let saved!: UIMessage
  const chunks = await decode(chat.respond({ threadId: 'chat', messages: [user], instructions: '', onFinish: async (message) => {
    saved = message
  } }))
  expect(chunks).toContainEqual({ type: 'tool-output-available', toolCallId: call.call_id, output: args })
  expect(chunks).toContainEqual({ type: 'source-url', sourceId: 'https://example.com/trends', url: 'https://example.com/trends', title: 'Trends' })
  expect(chunks.at(-1)?.type).toBe('finish')
  expect(requests).toHaveLength(2)
  const expected = [
    expect.objectContaining({ type: 'reasoning', id: reasoning.id, encrypted_content: 'opaque-reasoning' }),
    search,
    expect.objectContaining({ type: 'function_call', call_id: call.call_id, arguments: call.arguments }),
    expect.objectContaining({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(args) })
  ]
  expect(requests[1]!.input).toEqual(expect.arrayContaining(expected))
  const reloaded = await createKeundalChat('openai/gpt-5-nano', { webSearch: true, reasoning: false }, env)
  onTestFinished(reloaded.dispose)
  await decode(reloaded.respond({ threadId: 'chat', messages: [user, JSON.parse(JSON.stringify(saved)), { id: 'user-2', role: 'user', parts: [{ type: 'text', text: '계속' }] }], instructions: '' }))
  expect(requests[2]!.input).toEqual(expect.arrayContaining(expected))
  expect(requests[2]!.reasoning).toEqual({ effort: 'low' })
})

test('Gemini chart 호출의 thoughtSignature를 후속 요청에 보존한다', async () => {
  const requests: Record<string, unknown>[] = []
  const args = { data: [{ month: 'Jan', sales: 17 }], xKey: 'month', series: [{ key: 'sales', name: 'Sales', color: '#3b82f6' }] }
  const baseURL = await setup((body, response) => {
    requests.push(body)
    send(response, [{ responseId: 'gemini-tools', candidates: [{ content: { role: 'model', parts: requests.length === 1
      ? [{ functionCall: { id: 'call_gemini', name: 'chart', args }, thoughtSignature: 'opaque-gemini-signature' }]
      : [{ text: '1월 매출은 17입니다' }] }, finishReason: 'STOP' }] }])
  })
  const chat = await createKeundalChat('google/gemini-3-flash', { reasoning: true }, { GEMINI_API_KEY: 'local-test-key', GEMINI_BASE_URL: baseURL })
  onTestFinished(chat.dispose)
  const chunks = await decode(chat.respond({ threadId: 'chat', messages: [user], instructions: '' }))
  expect(chunks.at(-1)?.type).toBe('finish')
  expect(requests).toHaveLength(2)
  expect(requests[1]!.contents).toEqual(expect.arrayContaining([
    { role: 'model', parts: [{ functionCall: { name: 'chart', args }, thoughtSignature: 'opaque-gemini-signature' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'chart', response: args } }] }
  ]))
  expect(requests[0]!.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'HIGH' } })
})

test('취소하면 응답을 기다리는 공급자 연결과 UI 스트림을 종료한다', async () => {
  let disconnected!: () => void
  const closed = new Promise<void>(resolve => disconnected = resolve)
  let started!: () => void
  const connected = new Promise<void>(resolve => started = resolve)
  const baseURL = await setup((_body, response) => {
    response.once('close', disconnected)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'pending' } })}\n\n`)
    started()
  })
  const chat = await createKeundalChat('openai/gpt-5-nano', {}, { OPENAI_API_KEY: 'local-test-key', OPENAI_BASE_URL: baseURL })
  onTestFinished(chat.dispose)
  const controller = new AbortController()
  const consuming = decode(chat.respond({ threadId: 'chat', messages: [user], instructions: '', signal: controller.signal }))
  await connected
  controller.abort()
  expect(await consuming).toContainEqual({ type: 'abort' })
  await closed
})

test('공급자 오류를 성공 응답으로 바꾸거나 자동 재시도하지 않는다', async () => {
  let calls = 0
  const baseURL = await setup((_body, response) => {
    calls++
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Rate limited', type: 'rate_limit_error' } }))
  })
  const chat = await createKeundalChat('openai/gpt-5-nano', {}, { OPENAI_API_KEY: 'local-test-key', OPENAI_BASE_URL: baseURL })
  onTestFinished(chat.dispose)
  const chunks = await decode(chat.respond({ threadId: 'chat', messages: [user], instructions: '' }))
  expect(chunks).toContainEqual({ type: 'error', errorText: expect.stringContaining('HTTP 429') })
  expect(chunks.some(chunk => chunk.type === 'finish')).toBe(false)
  expect(calls).toBe(1)
})

test('키와 API URL 변경을 재시작 없이 적용하고 삭제한 키와 공급자가 반사한 키를 실행 이력에 남기지 않는다', async () => {
  const authorizations: (string | undefined)[] = []
  const firstURL = await setup((_body, response, request) => {
    authorizations.push(request.headers.authorization)
    send(response, openaiText('첫 번째 설정'))
  })
  let rejected = false
  const secondURL = await setup((_body, response, request) => {
    authorizations.push(request.headers.authorization)
    if (!rejected) return send(response, openaiText('변경한 설정'))
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Incorrect API key: second-private-key', type: 'authentication_error' } }))
  })
  const settings = defaultLLMSettings()
  settings.openai = { apiKey: 'first-private-key', baseURL: firstURL }
  const ctx = new Context()
  const llm = ctx.plugin(browserLLMPlugin, { getSettings: () => settings })
  await llm
  const store = ctx.plugin(memoryStorePlugin)
  await store
  const chats = new ChatStore(ctx)
  onTestFinished(async () => {
    await chats.stop()
    await store.dispose()
    await llm.dispose()
  })
  await chats.create('settings', user, 'openai/gpt-5-nano')
  expect(await (await chats.respond('settings', { model: 'openai/gpt-5-nano', messages: [user] })).text()).toContain('첫 번째 설정')
  settings.openai = { apiKey: 'second-private-key', baseURL: secondURL }
  const followup: UIMessage = { id: 'followup', role: 'user', parts: [{ type: 'text', text: '설정 변경 후 요청' }] }
  const messages = [...(await chats.get('settings'))!.messages, followup]
  expect(await (await chats.respond('settings', { model: 'openai/gpt-5-nano', messages })).text()).toContain('변경한 설정')
  rejected = true
  const failed = await (await chats.respond('settings', { model: 'openai/gpt-5-nano', messages })).text()
  expect(failed).toContain('HTTP 401')
  expect(failed).not.toContain('second-private-key')
  expect(authorizations).toEqual(['Bearer first-private-key', 'Bearer first-private-key', 'Bearer second-private-key', 'Bearer second-private-key'])
  const persisted = JSON.stringify({ session: await ctx.session.get('settings'), runs: await ctx.generation.list() })
  for (const value of ['first-private-key', 'second-private-key', firstURL, secondURL]) expect(persisted).not.toContain(value)
  settings.openai = { apiKey: '', baseURL: '' }
  await expect(ctx.llm.countTokens({ model: 'gpt-5-nano', maxOutputTokens: 4096, input: { threadId: 'settings', runId: 'forgotten', messages: [], tools: [], context: [], state: {} } })).rejects.toThrow('add your openai API key')
  expect(authorizations).toHaveLength(4)
})

test('Anthropic 추론 중 중단한 대화를 다시 보내도 서명 없는 부분 추론을 재생하지 않는다', async () => {
  let calls = 0
  const baseURL = await setup((_body, response) => {
    if (calls++) return send(response, anthropicText('계속 진행합니다'))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const frame of [
      { type: 'message_start', message: { id: 'partial', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '부분 추론' } }
    ]) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
  })
  const env = { ANTHROPIC_API_KEY: 'local-test-key', ANTHROPIC_BASE_URL: baseURL }
  const chat = await createKeundalChat('anthropic/claude-haiku-4.5', { reasoning: true }, env)
  onTestFinished(chat.dispose)
  const controller = new AbortController()
  let saved!: UIMessage
  const chunks = await decode(chat.respond({ threadId: 'chat', messages: [user], instructions: '', signal: controller.signal, onFinish: async (message) => {
    saved = message
  } }), (chunk) => {
    if (chunk.type === 'reasoning-delta') controller.abort()
  })
  expect(chunks).toContainEqual({ type: 'abort' })
  expect(saved.parts).toContainEqual({ type: 'reasoning', text: '부분 추론' })
  const resumed = await createKeundalChat('anthropic/claude-haiku-4.5', { reasoning: true }, env)
  onTestFinished(resumed.dispose)
  const next = await decode(resumed.respond({ threadId: 'chat', messages: [user, saved, { id: 'user-2', role: 'user', parts: [{ type: 'text', text: '계속' }] }], instructions: '' }))
  expect(next.at(-1)?.type).toBe('finish')
  expect(calls).toBe(2)
})
