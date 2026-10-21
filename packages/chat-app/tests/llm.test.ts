import { mountAgent } from './fixtures/agent'
import { Buffer } from 'node:buffer'
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http'
import { EventType, LLM_SOURCE_EVENT, type AGUIEvent, type Reasoning } from '@keundal/core'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { expect, test, onTestFinished, vi } from 'vitest'
import { Context } from 'cordis'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { browserLLMPlugin } from '@keundal/plugin-llm-browser'
import { createKeundalChat as createChat } from '@keundal/plugin-chat-local/keundal'
import { ChatStore } from '@keundal/plugin-chat-local'
import { defaultLLMSettings, providerSettingsSchema } from '@keundal/chat/llm-settings'

test('공급자 모듈을 불러오는 동안 취소하면 모델 조회를 중단한다', async () => {
  const ctx = new Context()
  const llm = ctx.plugin(browserLLMPlugin, { getSettings: defaultLLMSettings })
  await llm
  onTestFinished(() => llm.dispose())
  const controller = new AbortController()
  const pending = ctx.llm.getModel('openai/test-model', { signal: controller.signal })
  controller.abort(new Error('모델 조회 취소'))
  await expect(pending).rejects.toThrow('모델 조회 취소')
})

test('공급자 모듈을 불러오는 동안 서비스를 해제하면 공급자를 새로 만들지 않는다', async () => {
  const ctx = new Context()
  const llm = ctx.plugin(browserLLMPlugin, { getSettings: defaultLLMSettings })
  await llm
  onTestFinished(() => llm.dispose())
  const pending = ctx.llm.getModel('openai/test-model')
  const rejected = expect(pending).rejects.toThrow('Browser LLM service is disposed')
  await llm.dispose()
  await rejected
})

async function createKeundalChat(name: string, options: { webSearch?: boolean, reasoning?: Reasoning }, env: Record<string, string>) {
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
  return createChat(ctx, name, options, mountAgent)
}

type Frame = Record<string, unknown>
const user: ChatMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '서울 날씨' }, { type: 'file', url: 'data:image/png;base64,iVBORw==', mediaType: 'image/png' }] }

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

async function setup(handle: (body: Record<string, unknown>, response: ServerResponse, request: IncomingMessage) => void, tokenStatus = 200, onRequest?: (request: IncomingMessage) => void) {
  const server = createServer(async (request, response) => {
    onRequest?.(request)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (/input_tokens|count_tokens|:countTokens/.test(request.url ?? '')) {
      response.writeHead(tokenStatus, { 'content-type': 'application/json' })
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

async function collect(stream: AsyncIterable<AGUIEvent>, onChunk?: (chunk: AGUIEvent) => void) {
  const chunks: AGUIEvent[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    onChunk?.(chunk)
  }
  return chunks
}

test.each([
  { name: 'openai/gpt-5-nano', key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL', id: 'gpt-5-nano', frames: openaiText('서울은 맑아요') },
  { name: 'anthropic/claude-haiku-4.5', key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL', id: 'claude-haiku-4-5', frames: anthropicText('서울은 맑아요') },
  { name: 'google/gemini-3-flash', key: 'GEMINI_API_KEY', url: 'GEMINI_BASE_URL', id: 'gemini-3-flash-preview', frames: [{ responseId: 'gemini-answer', candidates: [{ content: { role: 'model', parts: [{ text: '서울은 맑아요' }] }, finishReason: 'STOP' }] }] },
  { name: 'openai/shared-model', key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL', id: 'shared-model', frames: openaiText('서울은 맑아요') },
  { name: 'anthropic/shared-model', key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL', id: 'shared-model', frames: anthropicText('서울은 맑아요') }
])('$name: 제목과 이미지 대화를 실행하고 AG-UI 이벤트와 표시 메시지를 보존한다', async ({ name, key, url, id, frames }) => {
  const received: Record<string, unknown>[] = []
  const baseURL = await setup((body, response) => {
    received.push(body)
    send(response, frames)
  })
  const chat = await createKeundalChat(name, { reasoning: false }, { [key]: 'local-test-key', [url]: baseURL })
  onTestFinished(chat.dispose)
  expect(await chat.title(user)).toBe('서울은 맑아요')
  let saved: ChatMessage | undefined
  const chunks = await collect(chat.respond({ threadId: 'chat', messages: [user], instructions: '도움말', onFinish: async (message) => {
    saved = message
  } }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: EventType.TEXT_MESSAGE_CONTENT, delta: '서울은 맑아요' }))
  expect(chunks.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, threadId: 'chat' })
  expect(saved?.parts).toContainEqual({ type: 'text', text: '서울은 맑아요' })
  expect(received).toHaveLength(2)
  expect(JSON.stringify(received[1])).toContain('iVBORw==')
  expect(JSON.stringify(received[1])).toContain('image/png')
  if (key !== 'GEMINI_API_KEY') expect(received.every(body => body.model === id)).toBe(true)
  if (id === 'gpt-5-nano') expect(received[1]!.reasoning).toEqual({ effort: 'minimal' })
  if (key === 'OPENAI_API_KEY' && id === 'shared-model') expect(received[1]).not.toHaveProperty('reasoning')
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
  let saved!: ChatMessage
  const chunks = await collect(chat.respond({ threadId: 'chat', messages: [user], instructions: '', onFinish: async (message) => {
    saved = message
  } }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: EventType.TOOL_CALL_RESULT, toolCallId: call.call_id, content: JSON.stringify(args) }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: EventType.CUSTOM, name: LLM_SOURCE_EVENT, value: expect.objectContaining({ url: 'https://example.com/trends', title: 'Trends' }) }))
  expect(saved.parts).toContainEqual(expect.objectContaining({ type: 'tool-chart', state: 'output-available', input: args, output: args }))
  expect(saved.parts).toContainEqual({ type: 'source-url', sourceId: 'https://example.com/trends', url: 'https://example.com/trends', title: 'Trends' })
  expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED)
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
  await collect(reloaded.respond({ threadId: 'chat', messages: [user, JSON.parse(JSON.stringify(saved)), { id: 'user-2', role: 'user', parts: [{ type: 'text', text: '계속' }] }], instructions: '' }))
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
  const chunks = await collect(chat.respond({ threadId: 'chat', messages: [user], instructions: '' }))
  expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED)
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
  const consuming = collect(chat.respond({ threadId: 'chat', messages: [user], instructions: '', signal: controller.signal }))
  await connected
  controller.abort()
  expect((await consuming).some(event => event.type === EventType.RUN_FINISHED)).toBe(false)
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
  const chunks = await collect(chat.respond({ threadId: 'chat', messages: [user], instructions: '' }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: EventType.RUN_ERROR, message: expect.stringContaining('HTTP 429') }))
  expect(chunks.some(chunk => chunk.type === EventType.RUN_FINISHED)).toBe(false)
  expect(calls).toBe(1)
})

test.each(['openai', 'anthropic', 'google'] as const)('%s의 토큰·제목·생성에 커스텀 헤더를 보내고 400 원인은 표시하되 비밀 값은 저장하지 않는다', async (provider) => {
  const requests: IncomingMessage[] = []
  let generations = 0
  const baseURL = await setup((_body, response) => {
    if (generations++ === 0) return send(response, provider === 'openai' ? openaiText('오류 확인') : provider === 'anthropic' ? anthropicText('오류 확인') : [{ responseId: 'title', candidates: [{ content: { role: 'model', parts: [{ text: '오류 확인' }] }, finishReason: 'STOP' }] }])
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 400, message: 'Unsupported parameter: temperature; key=private-400-key; gateway=private-header; auth=custom-auth-token' } }))
  }, 200, request => requests.push(request))
  const authHeader = provider === 'openai' ? 'Authorization' : provider === 'anthropic' ? 'X-Api-Key' : 'X-Goog-Api-Key'
  const settings = defaultLLMSettings()
  settings[provider] = { apiKey: 'private-400-key', baseURL, headers: { 'X-Gateway-Token': 'private-header', [authHeader]: provider === 'openai' ? 'Bearer custom-auth-token' : 'custom-auth-token' } }
  const ctx = new Context()
  const llm = await ctx.plugin(browserLLMPlugin, { getSettings: () => settings })
  const store = await ctx.plugin(memoryStorePlugin)
  const chats = new ChatStore(ctx, mountAgent)
  onTestFinished(async () => {
    await chats.stop()
    await store.dispose()
    await llm.dispose()
  })
  const model = `${provider}/shared-model`
  await chats.create('bad-request', user, model)
  const chunks = await collect(chats.respond('bad-request', { model, messages: [user] }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: EventType.RUN_ERROR, message: expect.stringContaining('HTTP 400). Unsupported parameter: temperature') }))
  expect(chunks.some(chunk => chunk.type === EventType.RUN_FINISHED)).toBe(false)
  expect(requests.some(request => /input_tokens|count_tokens|:countTokens/.test(request.url!))).toBe(true)
  expect(generations).toBe(2)
  for (const request of requests) {
    expect(request.headers['x-gateway-token']).toBe('private-header')
    expect(request.headers[authHeader.toLowerCase()]).toBe(provider === 'openai' ? 'Bearer custom-auth-token' : 'custom-auth-token')
  }
  const persisted = JSON.stringify({ session: await ctx.session.get('bad-request'), runs: await ctx.generation.list() })
  expect((await ctx.generation.list())[0]!.status).toBe('failed')
  for (const secret of ['private-400-key', 'private-header', 'custom-auth-token', baseURL]) {
    expect(JSON.stringify(chunks)).not.toContain(secret)
    expect(persisted).not.toContain(secret)
  }
})

test('기존 헤더 없는 설정은 유지하고 잘못된 헤더 이름·줄바꿈·중복·숫자 값은 거부한다', () => {
  const settings = { apiKey: 'key', baseURL: '' }
  expect(providerSettingsSchema.parse(settings)).toEqual(settings)
  expect(providerSettingsSchema.parse({ ...settings, headers: { 'X-Gateway': 'value' } }).headers).toEqual({ 'x-gateway': 'value' })
  for (const headers of [{ 'bad name': 'value' }, { 'X-Key': 'value\r\nInjected: yes' }, { 'X-Key': 'one', 'x-key': 'two' }, { 'X-Key': 123 }, ['not-a-record']]) {
    expect(providerSettingsSchema.safeParse({ ...settings, headers }).success).toBe(false)
  }
})

test('토큰 계산이 404인 호환 API에서도 답변을 저장하고 생성 요청의 인증 오류는 숨기지 않는다', async () => {
  let rejected = false
  const baseURL = await setup((_body, response) => {
    if (!rejected) return send(response, openaiText('호환 API 답변'))
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Incorrect key: private-compat-key' } }))
  }, 404)
  const settings = defaultLLMSettings()
  settings.openai = { apiKey: 'private-compat-key', baseURL }
  const ctx = new Context()
  const llm = await ctx.plugin(browserLLMPlugin, { getSettings: () => settings })
  const store = await ctx.plugin(memoryStorePlugin)
  const chats = new ChatStore(ctx, mountAgent)
  onTestFinished(async () => {
    await chats.stop()
    await store.dispose()
    await llm.dispose()
  })
  await chats.create('compat', user, 'openai/shared-model')
  const chunks = await collect(chats.respond('compat', { model: 'openai/shared-model', messages: [user] }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: EventType.RUN_FINISHED }))
  expect((await chats.get('compat'))!.messages.at(-1)!.parts).toContainEqual({ type: 'text', text: '호환 API 답변' })
  rejected = true
  const failed = await collect(chats.respond('compat', { model: 'openai/shared-model', messages: [user] }))
  expect(failed).toContainEqual(expect.objectContaining({ type: EventType.RUN_ERROR, message: expect.stringContaining('HTTP 401') }))
  expect(failed.some(chunk => chunk.type === EventType.RUN_FINISHED)).toBe(false)
  expect(JSON.stringify(failed)).not.toContain('private-compat-key')
})

test('키와 API URL 변경을 재시작 없이 적용하고 삭제한 키와 공급자가 반사한 키를 실행 이력에 남기지 않는다', async () => {
  const authorizations: (string | undefined)[] = []
  const budgets: unknown[] = []
  const firstURL = await setup((body, response, request) => {
    authorizations.push(request.headers.authorization)
    budgets.push(body.max_output_tokens)
    send(response, openaiText('첫 번째 설정'))
  })
  let rejected = false
  const secondURL = await setup((body, response, request) => {
    authorizations.push(request.headers.authorization)
    budgets.push(body.max_output_tokens)
    if (!rejected) return send(response, openaiText('변경한 설정'))
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Incorrect API key: second-private-key', type: 'authentication_error' } }))
  })
  const settings = defaultLLMSettings()
  settings.openai = { apiKey: 'first-private-key', baseURL: firstURL }
  const ctx = new Context()
  const llm = ctx.plugin(browserLLMPlugin, {
    getSettings: () => settings,
    getModels: () => [{ value: 'openai/gpt-5-nano', label: 'GPT-5 Nano', icon: '', contextWindow: 32768, maxOutputTokens: 1024 }]
  })
  await llm
  const store = ctx.plugin(memoryStorePlugin)
  await store
  const chats = new ChatStore(ctx, mountAgent)
  onTestFinished(async () => {
    await chats.stop()
    await store.dispose()
    await llm.dispose()
  })
  await chats.create('settings', user, 'openai/gpt-5-nano')
  expect(JSON.stringify(await collect(chats.respond('settings', { model: 'openai/gpt-5-nano', messages: [user] })))).toContain('첫 번째 설정')
  settings.openai = { apiKey: 'second-private-key', baseURL: secondURL }
  const followup: ChatMessage = { id: 'followup', role: 'user', parts: [{ type: 'text', text: '설정 변경 후 요청' }] }
  const messages = [...(await chats.get('settings'))!.messages, followup]
  expect(JSON.stringify(await collect(chats.respond('settings', { model: 'openai/gpt-5-nano', messages })))).toContain('변경한 설정')
  rejected = true
  const failed = JSON.stringify(await collect(chats.respond('settings', { model: 'openai/gpt-5-nano', messages })))
  expect(failed).toContain('HTTP 401')
  expect(failed).not.toContain('second-private-key')
  expect(authorizations).toEqual(['Bearer first-private-key', 'Bearer first-private-key', 'Bearer second-private-key', 'Bearer second-private-key'])
  expect(budgets).toEqual([1024, 1024, 1024, 1024])
  const persisted = JSON.stringify({ session: await ctx.session.get('settings'), runs: await ctx.generation.list() })
  for (const value of ['first-private-key', 'second-private-key', firstURL, secondURL]) expect(persisted).not.toContain(value)
  rejected = false
  settings.openai = { apiKey: '', baseURL: secondURL }
  expect(await ctx.llm.countTokens({ model: 'openai/gpt-5-nano', maxOutputTokens: 1024, input: { threadId: 'settings', runId: 'no-auth', messages: [], tools: [], context: [], state: {} } })).toBe(15)
  expect(JSON.stringify(await collect(chats.respond('settings', { model: 'openai/gpt-5-nano', messages })))).toContain('변경한 설정')
  expect(authorizations.at(-1)).toBeUndefined()
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
  let saved!: ChatMessage
  const chunks = await collect(chat.respond({ threadId: 'chat', messages: [user], instructions: '', signal: controller.signal, onFinish: async (message) => {
    saved = message
  } }), (chunk) => {
    if (chunk.type === EventType.REASONING_MESSAGE_CONTENT) controller.abort()
  })
  expect(chunks.some(event => event.type === EventType.RUN_FINISHED)).toBe(false)
  expect(saved.parts).toContainEqual({ type: 'reasoning', text: '부분 추론' })
  const resumed = await createKeundalChat('anthropic/claude-haiku-4.5', { reasoning: true }, env)
  onTestFinished(resumed.dispose)
  const next = await collect(resumed.respond({ threadId: 'chat', messages: [user, saved, { id: 'user-2', role: 'user', parts: [{ type: 'text', text: '계속' }] }], instructions: '' }))
  expect(next.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(calls).toBe(2)
})

test('브라우저 공급자가 컨텍스트 초과를 반환하면 오류 정보를 안전하게 보존하여 한 번 재시도한다', async () => {
  let calls = 0
  let summaries = 0
  const baseURL = await setup((body, response) => {
    if (JSON.stringify(body).includes('Summarize the conversation data')) {
      summaries++
      return send(response, openaiText('Earlier facts.'))
    }
    if (++calls === 1) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'Maximum context length exceeded' } }))
    } else send(response, openaiText('Recovered'))
  })
  const runtime = await createKeundalChat('openai/gpt-5-nano', {}, { OPENAI_API_KEY: 'local-test-key', OPENAI_BASE_URL: baseURL })
  onTestFinished(runtime.dispose)
  const messages: ChatMessage[] = Array.from({ length: 9 }, (_, index) => ({
    id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `Message ${index}` }]
  }))
  const events = await collect(runtime.respond({ threadId: 'overflow', messages, instructions: 'Be helpful.' }))
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(events).toContainEqual(expect.objectContaining({ type: EventType.TEXT_MESSAGE_CONTENT, delta: 'Recovered' }))
  expect(calls).toBe(2)
  expect(summaries).toBe(1)
})

test.each([
  { provider: 'openai', name: 'openai/local-model', frames: openaiText('인증 없는 응답') },
  { provider: 'anthropic', name: 'anthropic/local-model', frames: anthropicText('인증 없는 응답') },
  { provider: 'google', name: 'google/local-model', frames: [{ responseId: 'local', candidates: [{ content: { role: 'model', parts: [{ text: '인증 없는 응답' }] }, finishReason: 'STOP' }] }] }
] as const)('$provider: 빈 API 키로 토큰 계산과 제목·답변 생성을 수행하고 환경 인증을 전송하지 않는다', async ({ provider, name, frames }) => {
  for (const key of ['OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) vi.stubEnv(key, 'must-not-be-sent')
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  const requests: IncomingMessage[] = []
  const baseURL = await setup((_body, response) => send(response, [...frames]), 200, request => requests.push(request))
  const settings = defaultLLMSettings()
  settings[provider] = { apiKey: '', baseURL }
  const ctx = new Context()
  const llm = ctx.plugin(browserLLMPlugin, { getSettings: () => settings })
  await llm
  const store = ctx.plugin(memoryStorePlugin)
  await store
  const chat = await createChat(ctx, name, { reasoning: false }, mountAgent)
  onTestFinished(async () => {
    await chat.dispose()
    await store.dispose()
    await llm.dispose()
  })
  expect(await ctx.llm.countTokens({ model: name, maxOutputTokens: 4096, input: { threadId: 'no-auth', runId: 'count', messages: [{ id: 'user', role: 'user', content: 'hello' }], tools: [], context: [], state: {} } })).toBe(15)
  expect(await chat.title(user)).toBe('인증 없는 응답')
  expect(await collect(chat.respond({ threadId: 'no-auth', messages: [user], instructions: '' }))).toContainEqual(expect.objectContaining({ type: EventType.TEXT_MESSAGE_CONTENT, delta: '인증 없는 응답' }))
  expect(requests).toHaveLength(4)
  for (const request of requests) {
    for (const header of ['authorization', 'api-key', 'x-api-key', 'x-goog-api-key']) expect(request.headers[header]).toBeUndefined()
    expect(request.url).not.toContain('must-not-be-sent')
  }
  settings[provider].headers = { 'Authorization': 'Bearer gateway-token', 'X-Gateway-Token': 'custom-value' }
  expect(await chat.title(user)).toBe('인증 없는 응답')
  for (const request of requests.slice(4)) {
    expect(request.headers.authorization).toBe('Bearer gateway-token')
    expect(request.headers['x-gateway-token']).toBe('custom-value')
    expect(request.headers['x-api-key']).toBeUndefined()
    expect(request.headers['x-goog-api-key']).toBeUndefined()
  }
  if (provider !== 'openai') {
    const apiHeader = provider === 'google' ? 'X-Goog-Api-Key' : 'X-Api-Key'
    settings[provider].headers = { [apiHeader]: 'gateway-key' }
    expect(await chat.title(user)).toBe('인증 없는 응답')
    expect(requests.at(-1)!.headers[apiHeader.toLowerCase()]).toBe('gateway-key')
    expect(requests.at(-1)!.headers.authorization).toBeUndefined()
  }
})

test('같은 종류의 공급자를 전환하면 제목과 생성 요청을 선택한 주소와 키로 보내고 삭제된 설정은 거부한다', async () => {
  const settings = defaultLLMSettings()
  const requests: string[] = []
  for (const name of ['work', 'home']) {
    const baseURL = await setup((_body, response) => send(response, openaiText(name)), 200, (request) => {
      requests.push(`${name}:${request.headers.authorization}`)
    })
    settings[`openai@${name}`] = { name, apiKey: `${name}-key`, baseURL }
  }
  const ctx = new Context()
  const llm = ctx.plugin(browserLLMPlugin, { getSettings: () => settings })
  await llm
  const store = ctx.plugin(memoryStorePlugin)
  await store
  onTestFinished(async () => {
    await store.dispose()
    await llm.dispose()
  })
  for (const name of ['work', 'home']) {
    const chat = await createChat(ctx, `openai@${name}/shared`, {}, mountAgent)
    try {
      expect(await chat.title(user)).toBe(name)
      const events: AGUIEvent[] = []
      for await (const event of chat.respond({ threadId: crypto.randomUUID(), messages: [user], instructions: '' })) events.push(event)
      expect(events.some(event => event.type === EventType.RUN_FINISHED)).toBe(true)
    } finally { await chat.dispose() }
  }
  expect(requests).toContain('work:Bearer work-key')
  expect(requests).toContain('home:Bearer home-key')
  delete settings['openai@work']
  await expect(ctx.llm.getModel('openai@work/shared')).rejects.toThrow('configuration')
})

test.each(['low', 'medium', 'high'] as const)('%s 추론 수준을 각 공급자의 생성 요청에 전달한다', async (reasoning) => {
  for (const provider of [
    { name: 'openai/gpt-5-nano', key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL', frames: openaiText('답변') },
    { name: 'google/gemini-3-flash', key: 'GEMINI_API_KEY', url: 'GEMINI_BASE_URL', frames: [{ candidates: [{ content: { parts: [{ text: '답변' }] }, finishReason: 'STOP' }] }] },
    { name: 'anthropic/claude-haiku-4.5', key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL', frames: anthropicText('답변') }
  ]) {
    const requests: Record<string, unknown>[] = []
    const baseURL = await setup((body, response) => {
      requests.push(body)
      send(response, provider.frames)
    })
    const chat = await createKeundalChat(provider.name, { reasoning }, { [provider.key]: 'test-key', [provider.url]: baseURL })
    onTestFinished(chat.dispose)
    const events = await collect(chat.respond({ threadId: 'levels', messages: [user], instructions: '도움말' }))
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(requests).toHaveLength(1)
    if (provider.key === 'OPENAI_API_KEY') expect(requests[0]!.reasoning).toEqual({ effort: reasoning, summary: 'auto' })
    if (provider.key === 'GEMINI_API_KEY') expect(requests[0]!.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: reasoning.toUpperCase(), includeThoughts: true } })
    if (provider.key === 'ANTHROPIC_API_KEY') expect(requests[0]!.thinking).toEqual({ type: 'enabled', budget_tokens: { low: 1024, medium: 2048, high: 3072 }[reasoning] })
  }
})
