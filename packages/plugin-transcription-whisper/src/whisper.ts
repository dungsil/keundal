import type { SpeechWord, TranscribedSegment } from '@keundal/transcription'

export interface WhisperTranscription {
  readonly language: string | null
  readonly segments: readonly TranscribedSegment[]
  readonly words: readonly SpeechWord[]
}

const SPECIAL_TOKEN = /^\[.*\]$/

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function range(value: unknown): { from: number; to: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const offsets = value as Record<string, unknown>
  const from = offsets.from
  const to = offsets.to
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) || from < 0)
    return null
  return { from, to }
}

/**
 * `whisper.cpp`가 `-oj`로 남긴 JSON을 해석합니다.
 * 토큰을 단어 시각으로 쓰고, 특수 토큰은 버립니다.
 */
export function parseWhisperJson(source: string): WhisperTranscription {
  const root = object(JSON.parse(source), 'whisper output')
  const result = root.result === undefined ? {} : object(root.result, 'whisper result')
  const language = typeof result.language === 'string' && result.language.length > 0 ? result.language : null
  if (!Array.isArray(root.transcription)) throw new Error('whisper output has no transcription')
  const segments: TranscribedSegment[] = []
  const words: SpeechWord[] = []
  for (const entry of root.transcription) {
    const segment = object(entry, 'whisper segment')
    const span = range(segment.offsets)
    const text = typeof segment.text === 'string' ? segment.text.trim() : ''
    if (span && text.length > 0 && span.to > span.from) {
      segments.push({ startMs: span.from, endMs: span.to, text })
    }
    if (!Array.isArray(segment.tokens)) continue
    for (const rawToken of segment.tokens) {
      const token = object(rawToken, 'whisper token')
      const tokenSpan = range(token.offsets)
      const text = typeof token.text === 'string' ? token.text.trim() : ''
      if (!tokenSpan || text.length === 0 || SPECIAL_TOKEN.test(text)) continue
      if (tokenSpan.to <= tokenSpan.from) continue
      words.push({ text, startMs: tokenSpan.from, endMs: tokenSpan.to })
    }
  }
  return { language, segments, words }
}
