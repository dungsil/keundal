import { once } from 'node:events'
import { createServer } from 'node:http'

import type { TranscriptionSession } from '@keundal/core'
import plugin from '@keundal/plugin-transcription-openai'
import { encodeRealtimeAudio, resampleAudio, streamTranscription } from '@keundal/plugin-transcription-openai/client'
import { Context } from 'cordis'
import { expect, test, onTestFinished, type TestContext } from 'vitest'
import { WebSocketServer } from 'ws'

async function fixture(t: Pick<TestContext, 'onTestFinished'>) {
  const requests: { url?: string; authorization?: string; body: unknown }[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) })
    if (req.headers.authorization === 'Bearer pending') return
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ value: 'ek_test', expires_at: 123456, session: { type: 'transcription' } }))
  })
  const ws = new WebSocketServer({ server })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  t.onTestFinished(async () => {
    for (const client of ws.clients) client.terminate()
    ws.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const session: TranscriptionSession = {
    clientSecret: 'ek_test',
    expiresAt: 123456,
    url: `ws://127.0.0.1:${address.port}/v1/realtime?intent=transcription`,
    protocols: ['realtime', 'openai-insecure-api-key.ek_test'],
    audio: { format: 'pcm16', sampleRate: 24000, channels: 1 }
  }
  return { ws, requests, session, baseURL: `http://127.0.0.1:${address.port}/v1` }
}

test('공개 서비스가 OpenAI REST 자격 증명과 PCM 세션을 생성하고 서버 키를 숨긴다', async (t) => {
  const { baseURL, requests } = await fixture(t)
  const ctx = new Context()
  const fiber = await ctx.plugin(plugin, { apiKey: 'server-key', baseURL })
  t.onTestFinished(() => fiber.dispose())
  const session = await ctx.transcription.createSession({ model: 'gpt-4o-mini-transcribe' })
  expect(JSON.stringify(session)).not.toContain('server-key')
  expect(session.protocols).toEqual(['realtime', 'openai-insecure-api-key.ek_test'])
  expect(requests[0]).toEqual({
    url: '/v1/realtime/client_secrets',
    authorization: 'Bearer server-key',
    body: {
      expires_after: { anchor: 'created_at', seconds: 300 },
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: null
          }
        }
      }
    }
  })
})

test('진행 중 REST 요청을 외부 취소와 플러그인 해제로 중단한다', async (t) => {
  const { baseURL, requests } = await fixture(t)
  const ctx = new Context()
  const fiber = await ctx.plugin(plugin, { apiKey: 'pending', baseURL })
  const abort = new AbortController()
  const first = ctx.transcription.createSession({ model: 'test' }, { signal: abort.signal })
  const assertion = expect(first).rejects.toThrow()
  await expect.poll(() => requests.length).toBe(1)
  abort.abort()
  await assertion
  const second = ctx.transcription.createSession({ model: 'test' })
  const disposed = expect(second).rejects.toThrow()
  await expect.poll(() => requests.length).toBe(2)
  await fiber.dispose()
  await disposed
  await expect(
    ctx.transcription?.createSession({ model: 'test' }) ?? Promise.reject(new Error('disposed'))
  ).rejects.toThrow()
})

test('WebSocket 부분 결과를 전달하고 stop의 짧은 PCM을 패딩하여 최종 결과까지 기다린다', async (t) => {
  const { ws, session } = await fixture(t)
  const frames: { type: string; audio?: string }[] = []
  ws.on('connection', (socket, req) => {
    expect(req.headers['sec-websocket-protocol']).toContain('openai-insecure-api-key.ek_test')
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data))
      frames.push(frame)
      if (frame.type === 'input_audio_buffer.commit') {
        for (const event of [
          { type: 'input_audio_buffer.committed', item_id: 'one' },
          { type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: '안녕' },
          { type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: '안녕하세요' }
        ])
          socket.send(JSON.stringify(event))
      }
    })
  })
  const audio = new ReadableStream<string>({
    start(c) {
      c.enqueue(encodeRealtimeAudio(new Float32Array(24)))
      c.close()
    }
  })
  const result = streamTranscription({ session, audio })
  const parts = []
  for await (const part of result.fullStream) parts.push(part)
  expect(await result.text).toBe('안녕하세요')
  expect(parts).toEqual([
    { type: 'transcript-delta', delta: '안녕' },
    { type: 'transcript-partial', text: '안녕' },
    { type: 'transcript-final', text: '안녕하세요' },
    { type: 'transcript-partial', text: '' }
  ])
  expect(frames.filter((f) => f.audio).reduce((n, f) => n + atob(f.audio!).length / 2, 0)).toBe(2400)
  await expect.poll(() => ws.clients.size).toBe(0)
})

test.each(['abort', 'error', 'close', 'timeout'])('WebSocket %s 이후 오디오와 연결을 정리한다', async (mode) => {
  const { ws, session } = await fixture({ onTestFinished })
  let cancelled = false
  const audio = new ReadableStream<string>({
    start(c) {
      if (mode === 'timeout') {
        c.enqueue(encodeRealtimeAudio(new Float32Array(2400)))
        c.close()
      }
    },
    cancel() {
      cancelled = true
    }
  })
  const abort = new AbortController()
  ws.on('connection', (socket) => {
    if (mode === 'abort') abort.abort(new Error('cancelled'))
    if (mode === 'error') socket.send(JSON.stringify({ type: 'error', error: { message: 'fixture error' } }))
    if (mode === 'close') socket.close()
  })
  const result = streamTranscription({ session, audio, signal: abort.signal, timeoutMs: 100 })
  await expect(result.text).rejects.toThrow()
  if (mode !== 'timeout') await expect.poll(() => cancelled).toBe(true)
  await expect.poll(() => ws.clients.size).toBe(0)
})

test('녹음 중 두 턴을 커밋하고 역순 완료를 발화 순서로 정렬하며 stop은 남은 결과를 기다린다', async (t) => {
  const { ws, session } = await fixture(t)
  let controller!: ReadableStreamDefaultController<string>
  let commits = 0
  ws.on('connection', (socket) => {
    socket.on('message', (data) => {
      if (JSON.parse(String(data)).type !== 'input_audio_buffer.commit') return
      commits++
      socket.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: String(commits) }))
      if (commits === 2) {
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: '2',
            transcript: '둘'
          })
        )
        socket.send(
          JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: '1', delta: '하' })
        )
        setTimeout(
          () =>
            socket.send(
              JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                item_id: '1',
                transcript: '하나'
              })
            ),
          20
        )
      }
    })
  })
  const audio = new ReadableStream<string>({
    start(c) {
      controller = c
    }
  })
  const result = streamTranscription({ session, audio })
  const parts: { type: string; text?: string }[] = []
  const consumed = (async () => {
    for await (const part of result.fullStream) parts.push(part)
  })()
  controller.enqueue(encodeRealtimeAudio(new Float32Array(48000)))
  controller.enqueue(encodeRealtimeAudio(new Float32Array(48000)))
  await expect.poll(() => commits).toBe(2)
  expect(parts.some((p) => p.type === 'transcript-partial')).toBe(true)
  controller.close()
  expect(await result.text).toBe('하나 둘')
  await consumed
  expect(parts.filter((p) => p.type === 'transcript-final').map((p) => p.text)).toEqual(['하나', '둘'])
  expect(audio.locked).toBe(false)
})

test('오디오가 없으면 commit 없이 종료하고 빈 결과를 반환한다', async (t) => {
  const { ws, session } = await fixture(t)
  let sent = 0
  ws.on('connection', (socket) => socket.on('message', () => sent++))
  const audio = new ReadableStream<string>({
    start(c) {
      c.close()
    }
  })
  const result = streamTranscription({ session, audio })
  expect(await result.text).toBe('')
  expect(sent).toBe(0)
})

test('48kHz 오디오를 24kHz로 줄이고 PCM16 클리핑과 little endian을 보장한다', () => {
  expect([...resampleAudio(new Float32Array([0, 1, 0.5, -1]), 48000)]).toEqual([0, 0.5])
  const bytes = Buffer.from(encodeRealtimeAudio(new Float32Array([-2, 0, 2])), 'base64')
  expect([...bytes]).toEqual([0, 128, 0, 0, 255, 127])
})
