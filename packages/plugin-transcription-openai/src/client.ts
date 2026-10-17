import type { TranscriptionSession } from '@keundal/core'

/** Mono linear resampling; PCM is encoded explicitly little-endian, independent of host byte order. */
export function resampleAudio(input: Float32Array, from: number, to = 24000): Float32Array {
  if (!(from > 0 && to > 0)) throw new Error('Invalid sample rate')
  const output = new Float32Array(Math.round((input.length * to) / from))
  for (let i = 0; i < output.length; i++) {
    const position = (i * from) / to
    const left = Math.floor(position)
    const fraction = position - left
    output[i] = (input[left] ?? 0) * (1 - fraction) + (input[Math.min(left + 1, input.length - 1)] ?? 0) * fraction
  }
  return output
}

export function encodeRealtimeAudio(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return globalThis.btoa(binary)
}

export type TranscriptionPart =
  | { type: 'transcript-delta'; delta: string }
  | { type: 'transcript-partial'; text: string }
  | { type: 'transcript-final'; text: string }

/** Native browser transport. Audio is mono base64 PCM16 at session.audio.sampleRate.
 * Manual two-second turns keep mini-transcribe live without VAD/stop commit races.
 * Closing the audio stream flushes the last turn and waits for every final transcript.
 */
export function streamTranscription(options: {
  session: TranscriptionSession
  audio: ReadableStream<string>
  signal?: AbortSignal
  timeoutMs?: number
}): { fullStream: AsyncIterable<TranscriptionPart>; text: Promise<string> } {
  const { session, signal } = options
  let output!: ReadableStreamDefaultController<TranscriptionPart>
  const events = new globalThis.ReadableStream<TranscriptionPart>({
    start(controller) {
      output = controller
    }
  })
  const socket = new globalThis.WebSocket(session.url, [...session.protocols])
  const reader = options.audio.getReader()
  const finals = new Map<string, string>()
  const partials = new Map<string, string>()
  const order: string[] = []
  let commits = 0
  let completed = 0
  let samples = 0
  let stopping = false
  let settled = false
  let timer: ReturnType<typeof globalThis.setTimeout>
  let resolve!: (text: string) => void
  let reject!: (error: unknown) => void
  const text = new Promise<string>((yes, no) => {
    resolve = yes
    reject = no
  })
  // A microphone permission prompt can outlive a failed connection.
  void text.catch(() => {})
  const finish = (error?: unknown) => {
    if (settled) return
    settled = true
    globalThis.clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    socket.removeEventListener('open', open)
    socket.removeEventListener('message', message)
    socket.removeEventListener('error', socketError)
    socket.removeEventListener('close', close)
    void reader
      .cancel()
      .catch(() => {})
      .finally(() => reader.releaseLock())
    socket.close()
    if (error) {
      output.error(error)
      reject(error)
    } else {
      output.close()
      resolve(
        order
          .map((id) => finals.get(id) ?? '')
          .filter(Boolean)
          .join(' ')
      )
    }
  }
  const abort = () => finish(signal?.reason ?? new globalThis.DOMException('Aborted', 'AbortError'))
  const socketError = () => finish(new Error('Transcription WebSocket failed'))
  const close = () => finish(new Error('Transcription WebSocket closed before completion'))
  const send = (event: object) => socket.send(JSON.stringify(event))
  const commit = () => {
    if (!samples) return
    // OpenAI requires at least 100 ms per committed turn, including a very quick stop.
    if (samples < 2400)
      send({ type: 'input_audio_buffer.append', audio: encodeRealtimeAudio(new Float32Array(2400 - samples)) })
    send({ type: 'input_audio_buffer.commit' })
    commits++
    samples = 0
  }
  const maybeFinish = () => {
    if (stopping && completed === commits) finish()
  }
  const message = (event: MessageEvent) => {
    try {
      const frame = JSON.parse(String(event.data))
      if (frame.type === 'error' || frame.type === 'conversation.item.input_audio_transcription.failed')
        throw new Error(frame.error?.message ?? 'Transcription failed')
      if (frame.type === 'input_audio_buffer.committed') order.push(frame.item_id)
      if (frame.type === 'conversation.item.input_audio_transcription.delta') {
        partials.set(frame.item_id, (partials.get(frame.item_id) ?? '') + frame.delta)
        output.enqueue({ type: 'transcript-delta', delta: frame.delta })
      }
      if (frame.type === 'conversation.item.input_audio_transcription.completed' && !finals.has(frame.item_id)) {
        finals.set(frame.item_id, frame.transcript)
        completed++
        // Publish finals in commit order, even when inference completes out of order.
        while (published < order.length && finals.has(order[published])) {
          output.enqueue({ type: 'transcript-final', text: finals.get(order[published++])! })
        }
      }
      if (
        frame.type === 'conversation.item.input_audio_transcription.delta' ||
        frame.type === 'conversation.item.input_audio_transcription.completed'
      ) {
        output.enqueue({
          type: 'transcript-partial',
          text: order
            .slice(published)
            .map((id) => finals.get(id) ?? partials.get(id) ?? '')
            .filter(Boolean)
            .join(' ')
        })
        maybeFinish()
      }
    } catch (error) {
      finish(error)
    }
  }
  let published = 0
  const open = async () => {
    globalThis.clearTimeout(timer)
    try {
      while (!settled) {
        const chunk = await reader.read()
        if (settled) return
        if (chunk.done) {
          commit()
          stopping = true
          timer = globalThis.setTimeout(
            () => finish(new Error('Transcription finalization timed out')),
            options.timeoutMs ?? 15000
          )
          maybeFinish()
          return
        }
        if (socket.bufferedAmount > 2_000_000) throw new Error('Transcription connection is too slow')
        send({ type: 'input_audio_buffer.append', audio: chunk.value })
        samples += globalThis.atob(chunk.value).length / 2
        if (samples >= 48000) commit()
      }
    } catch (error) {
      finish(error)
    }
  }
  socket.addEventListener('open', open)
  socket.addEventListener('message', message)
  socket.addEventListener('error', socketError)
  socket.addEventListener('close', close)
  timer = globalThis.setTimeout(
    () => finish(new Error('Transcription connection timed out')),
    options.timeoutMs ?? 15000
  )
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  return {
    text,
    fullStream: {
      async *[Symbol.asyncIterator]() {
        const reader = events.getReader()
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) return
            yield part.value
          }
        } finally {
          reader.releaseLock()
          if (!settled) finish(new Error('Transcription consumer stopped'))
        }
      }
    }
  }
}
