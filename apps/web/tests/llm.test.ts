import { Buffer } from 'node:buffer'
import { createServer, type ServerResponse } from 'node:http'
import { generateText, streamText, tool, isStepCount } from 'ai'
import { expect, test, onTestFinished } from 'vitest'
import { z } from 'zod'
import { createKeundalModel } from '../server/llm/keundal'

type Frame = Record<string, unknown>

function openaiText(text: string): Frame[] {
  const item = { id: 'msg_answer', type: 'message', role: 'assistant', content: [] }
  return [
    { type: 'response.output_item.added', item },
    { type: 'response.output_text.delta', item_id: item.id, delta: text },
    { type: 'response.output_item.done', item: { ...item, content: [{ type: 'output_text', text }] } },
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

async function setup(handle: (body: Record<string, unknown>, response: ServerResponse) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    handle(JSON.parse(Buffer.concat(chunks).toString()), response)
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

test.each([
  { name: 'openai/gpt-5-nano', key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL', id: 'gpt-5-nano', frames: openaiText('서울은 맑아요') },
  { name: 'anthropic/claude-haiku-4.5', key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL', id: 'claude-haiku-4-5', frames: anthropicText('서울은 맑아요') },
  { name: 'google/gemini-3-flash', key: 'GEMINI_API_KEY', url: 'GEMINI_BASE_URL', id: 'gemini-3-flash-preview', frames: [{ responseId: 'gemini-answer', candidates: [{ content: { role: 'model', parts: [{ text: '서울은 맑아요' }] }, finishReason: 'STOP' }] }] }
])('$name: 기존 플러그인으로 제목 생성과 UI 메시지 스트리밍을 실행한다', async ({ name, key, url, id, frames }) => {
  const received: Record<string, unknown>[] = []
  const baseURL = await setup((body, response) => {
    received.push(body)
    send(response, frames)
  })
  const { model, dispose } = await createKeundalModel(name, { [key]: 'local-test-key', [url]: baseURL })
  onTestFinished(dispose)
  const title = await generateText({ model, prompt: '채팅 제목', maxRetries: 0 })
  expect(title.text).toBe('서울은 맑아요')
  const result = streamText({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: '서울 날씨' }, { type: 'file', data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }] }],
    maxRetries: 0
  })
  const response = result.toUIMessageStreamResponse()
  const wire = await response.text()
  expect(wire).toContain('"type":"text-delta"')
  expect(wire).toContain('서울은 맑아요')
  expect(wire).toContain('"type":"finish"')
  expect(await result.text).toBe('서울은 맑아요')
  expect(received).toHaveLength(2)
  expect(JSON.stringify(received[1])).toContain('iVBORw==')
  expect(JSON.stringify(received[1])).toContain('image/png')
  if (key !== 'GEMINI_API_KEY') expect(received.every(body => body.model === id)).toBe(true)
  expect(model.modelId).toBe(id)
})

test('추론 암호문과 분할된 도구 인수를 보존하고 도구 결과를 넣어 후속 응답을 생성한다', async () => {
  const requests: Record<string, unknown>[] = []
  const reasoning = { id: 'rs_original', type: 'reasoning', summary: [{ type: 'summary_text', text: '날씨를 확인합니다' }], encrypted_content: 'opaque-reasoning' }
  const call = { id: 'fc_original', type: 'function_call', call_id: 'call_weather', name: 'weather', arguments: '{"location":"부산"}' }
  const baseURL = await setup((body, response) => {
    requests.push(body)
    if (requests.length > 1) return send(response, openaiText('부산은 19도입니다'))
    send(response, [
      { type: 'response.output_item.added', item: { ...reasoning, summary: [] } },
      { type: 'response.output_item.done', item: reasoning },
      { type: 'response.output_item.added', item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: '{"location":' },
      { type: 'response.function_call_arguments.delta', item_id: call.id, delta: '"부산"}' },
      { type: 'response.output_item.done', item: call },
      { type: 'response.completed', response: { status: 'completed' } }
    ])
  })
  const { model, dispose } = await createKeundalModel('openai/gpt-5-nano', { OPENAI_API_KEY: 'local-test-key', OPENAI_BASE_URL: baseURL })
  onTestFinished(dispose)
  const result = streamText({
    model,
    prompt: '부산 날씨',
    maxRetries: 0,
    stopWhen: isStepCount(3),
    tools: { weather: tool({ inputSchema: z.object({ location: z.string() }), execute: async ({ location }) => ({ location, temperature: 19 }) }) }
  })
  await result.consumeStream()
  expect(await result.text).toBe('부산은 19도입니다')
  expect(requests).toHaveLength(2)
  expect(requests[1]!.input).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'reasoning', id: 'rs_original', encrypted_content: 'opaque-reasoning' }),
    expect.objectContaining({ type: 'function_call', call_id: 'call_weather', name: 'weather', arguments: '{"location":"부산"}' }),
    expect.objectContaining({ type: 'function_call_output', call_id: 'call_weather', output: '{"location":"부산","temperature":19}' })
  ]))
})

test('Gemini 도구 호출의 thoughtSignature를 후속 요청에 보존한다', async () => {
  const requests: Record<string, unknown>[] = []
  const baseURL = await setup((body, response) => {
    requests.push(body)
    send(response, [{
      responseId: 'gemini-tools',
      candidates: [{
        content: { role: 'model', parts: requests.length === 1
          ? [{ functionCall: { id: 'call_gemini', name: 'weather', args: { location: '제주' } }, thoughtSignature: 'opaque-gemini-signature' }]
          : [{ text: '제주는 23도입니다' }] },
        finishReason: 'STOP'
      }]
    }])
  })
  const { model, dispose } = await createKeundalModel('google/gemini-3-flash', { GEMINI_API_KEY: 'local-test-key', GEMINI_BASE_URL: baseURL })
  onTestFinished(dispose)
  const result = streamText({
    model,
    prompt: '제주 날씨',
    maxRetries: 0,
    stopWhen: isStepCount(3),
    tools: { weather: tool({ inputSchema: z.object({ location: z.string() }), execute: async ({ location }) => ({ location, temperature: 23 }) }) }
  })
  await result.consumeStream()
  expect(await result.text).toBe('제주는 23도입니다')
  expect(requests).toHaveLength(2)
  expect(requests[1]!.contents).toEqual(expect.arrayContaining([
    { role: 'model', parts: [{ functionCall: { name: 'weather', args: { location: '제주' } }, thoughtSignature: 'opaque-gemini-signature' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'weather', response: { location: '제주', temperature: 23 } } }] }
  ]))
})

test('취소하면 응답을 기다리는 실제 공급자 연결을 종료한다', async () => {
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
  const { model, dispose } = await createKeundalModel('openai/gpt-5-nano', { OPENAI_API_KEY: 'local-test-key', OPENAI_BASE_URL: baseURL })
  onTestFinished(dispose)
  const controller = new AbortController()
  const result = streamText({ model, prompt: '취소 테스트', abortSignal: controller.signal, maxRetries: 0 })
  const consuming = result.consumeStream()
  await connected
  controller.abort()
  await consuming
  await closed
})

test('공급자 오류를 성공 응답으로 바꾸거나 자동 재시도하지 않는다', async () => {
  let calls = 0
  const baseURL = await setup((_body, response) => {
    calls++
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Rate limited', type: 'rate_limit_error' } }))
  })
  const { model, dispose } = await createKeundalModel('openai/gpt-5-nano', { OPENAI_API_KEY: 'local-test-key', OPENAI_BASE_URL: baseURL })
  onTestFinished(dispose)
  await expect(generateText({ model, prompt: '오류 테스트', maxRetries: 0 })).rejects.toThrow('Rate limited')
  expect(calls).toBe(1)
})
