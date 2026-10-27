/**
 * 모델 응답에서 번역 줄 배열을 꺼냅니다.
 * 코드 펜스나 앞뒤 설명이 붙어도 첫 배열을 사용합니다.
 */
export function parseTranslatedLines(source: string, expected: number): string[] {
  const start = source.indexOf('[')
  const end = source.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('model did not return a JSON array')
  let value: unknown
  try {
    value = JSON.parse(source.slice(start, end + 1))
  } catch {
    throw new Error('model did not return valid JSON')
  }
  if (!Array.isArray(value)) throw new Error('model did not return a JSON array')
  if (value.length !== expected) {
    throw new Error(`model returned ${value.length} lines instead of ${expected}`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`line ${index} is not a string`)
    return entry.trim()
  })
}
