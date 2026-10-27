import type { SpeechWord, TranscribedSegment } from '@keundal/transcription'

export interface LineBreakOptions {
  /** 자막 한 줄의 최대 글자 수입니다. */
  readonly maxCharacters?: number
  /** 자막 한 줄의 최대 길이입니다. */
  readonly maxDurationMs?: number
  /** 이 시간 이상 말이 끊기면 줄을 나눕니다. */
  readonly gapMs?: number
}

const SENTENCE_END = /[.!?。！？]$/
const CLAUSE_END = /[,、·;:—]$/

const DEFAULTS = { maxCharacters: 42, maxDurationMs: 7_000, gapMs: 600 } as const

function length(words: readonly SpeechWord[]): number {
  return words.reduce((total, word) => total + word.text.trim().length + 1, 0) - 1
}

/**
 * 단어 시각을 자막 줄로 묶습니다.
 * 긴 문장은 침묵, 구두점, 글자 수, 길이 한도에서 나눕니다.
 */
export function buildSegments(
  words: readonly SpeechWord[],
  options: LineBreakOptions = {}
): readonly TranscribedSegment[] {
  const maxCharacters = options.maxCharacters ?? DEFAULTS.maxCharacters
  const maxDurationMs = options.maxDurationMs ?? DEFAULTS.maxDurationMs
  const gapMs = options.gapMs ?? DEFAULTS.gapMs
  if (maxCharacters < 1) throw new RangeError('maxCharacters must be positive')
  if (maxDurationMs < 1) throw new RangeError('maxDurationMs must be positive')
  if (gapMs < 0) throw new RangeError('gapMs must not be negative')

  const segments: TranscribedSegment[] = []
  let current: SpeechWord[] = []

  const flush = () => {
    if (current.length === 0) return
    const text = current
      .map((word) => word.text.trim())
      .filter((value) => value.length > 0)
      .join(' ')
      .trim()
    if (text.length > 0) {
      segments.push({ startMs: current[0]!.startMs, endMs: current.at(-1)!.endMs, text })
    }
    current = []
  }

  for (const word of words) {
    const text = word.text.trim()
    if (text.length === 0) continue
    const previous = current.at(-1)
    if (previous && word.startMs - previous.endMs >= gapMs) flush()
    if (current.length > 0) {
      const startMs = current[0]!.startMs
      if (word.endMs - startMs > maxDurationMs || length(current) + text.length + 1 > maxCharacters) flush()
    }
    current.push({ text, startMs: word.startMs, endMs: word.endMs })
    const characters = length(current)
    if (SENTENCE_END.test(text) && characters >= Math.ceil(maxCharacters / 2)) flush()
    else if (CLAUSE_END.test(text) && characters >= maxCharacters) flush()
  }
  flush()
  return segments
}
