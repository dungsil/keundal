import { buildSegments } from '@keundal/plugin-transcription-whisper'
import type { SpeechWord } from '@keundal/transcription'
import { expect, test } from 'vitest'

const words = (values: readonly [string, number, number][]): SpeechWord[] =>
  values.map(([text, startMs, endMs]) => ({ text, startMs, endMs }))

test('침묵이 길면 그 지점에서 줄을 나눈다', () => {
  const segments = buildSegments(
    words([
      ['첫', 0, 300],
      ['문장', 300, 700],
      ['둘째', 2_000, 2_400],
      ['문장', 2_400, 2_800]
    ]),
    { gapMs: 600 }
  )
  expect(segments).toEqual([
    { startMs: 0, endMs: 700, text: '첫 문장' },
    { startMs: 2_000, endMs: 2_800, text: '둘째 문장' }
  ])
})

test('글자 수 한도를 넘으면 다음 단어 전에서 나눈다', () => {
  const segments = buildSegments(
    words([
      ['가나다라', 0, 100],
      ['마바사아', 100, 200],
      ['자차카타', 200, 300]
    ]),
    { maxCharacters: 10, gapMs: 10_000 }
  )
  expect(segments).toEqual([
    { startMs: 0, endMs: 200, text: '가나다라 마바사아' },
    { startMs: 200, endMs: 300, text: '자차카타' }
  ])
  expect(segments.every((segment) => segment.text.length <= 10)).toBe(true)
})

test('길이 한도를 넘으면 중간에서 나눈다', () => {
  const segments = buildSegments(
    words([
      ['하나', 0, 1_000],
      ['둘', 1_000, 5_000],
      ['셋', 5_000, 9_000]
    ]),
    { maxDurationMs: 4_000, gapMs: 10_000, maxCharacters: 100 }
  )
  expect(segments.length).toBeGreaterThan(1)
  for (const segment of segments) expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(9_000)
})

test('문장 부호 뒤에서는 한도에 닿기 전에도 줄을 나눈다', () => {
  const segments = buildSegments(
    words([
      ['안녕하세요.', 0, 500],
      ['반갑습니다', 500, 1_000],
      ['오늘은', 1_000, 1_400]
    ]),
    { maxCharacters: 12, gapMs: 10_000 }
  )
  expect(segments[0]).toEqual({ startMs: 0, endMs: 500, text: '안녕하세요.' })
  expect(segments).toHaveLength(2)
})

test('빈 입력은 빈 배열을 돌려주고, 공백 단어는 버린다', () => {
  expect(buildSegments([])).toEqual([])
  expect(buildSegments(words([['   ', 0, 100]]))).toEqual([])
})

test('잘못된 한도는 거부한다', () => {
  expect(() => buildSegments([], { maxCharacters: 0 })).toThrow('maxCharacters')
  expect(() => buildSegments([], { gapMs: -1 })).toThrow('gapMs')
})
