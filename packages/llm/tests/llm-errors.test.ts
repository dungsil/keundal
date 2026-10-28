import { isTransientLLMError, llmRetryAfterMs } from '@keundal/llm'
import { expect, test } from 'vitest'

class APIConnectionTimeoutError extends Error {}

test.for([429, 500, 502, 503, 504, 529])('HTTP %s를 일시적 공급자 오류로 분류한다', (status) => {
  expect(isTransientLLMError(Object.assign(new Error('failure'), { status }))).toBe(true)
})

test.for([
  new Error('arbitrary network failure'),
  new TypeError('invalid request'),
  Object.assign(new Error('fetch failed'), { status: 401, cause: { code: 'ECONNRESET' } }),
  Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ECONNRESET' }),
  { status: 400, message: 'maximum context length exceeded' },
  { status: 501 },
  { code: 'context_length_exceeded', cause: { status: 503 } }
])('영구 오류·취소·컨텍스트 초과를 일시적 오류로 오인하지 않는다: %s', (error) => {
  expect(isTransientLLMError(error)).toBe(false)
})

test.for([
  { name: 'APIConnectionError' },
  { name: 'APIConnectionTimeoutError' },
  new APIConnectionTimeoutError('Request timed out.'),
  { cause: { code: 'ECONNRESET' } },
  new TypeError('Failed to fetch'),
  { code: 'llm_transient_error' }
])('연결 오류와 안전하게 보존한 오류 코드를 인식한다: %s', (error) => {
  expect(isTransientLLMError(error)).toBe(true)
})

test('Retry-After의 초·날짜와 안전한 숫자만 보존하며 잘못된 값은 무시한다', () => {
  expect(llmRetryAfterMs({ headers: new Headers({ 'retry-after': '1.5' }) })).toBe(1500)
  const date = Date.now() + 60_000
  const delay = llmRetryAfterMs({ headers: new Headers({ 'retry-after': new Date(date).toUTCString() }) })!
  expect(delay).toBeGreaterThan(58_000)
  expect(delay).toBeLessThanOrEqual(60_000)
  expect(llmRetryAfterMs({ retryAfterMs: 120_000 })).toBe(120_000)
  expect(llmRetryAfterMs({ headers: new Headers({ 'retry-after': 'secret' }) })).toBeUndefined()
  expect(llmRetryAfterMs({ retryAfterMs: NaN })).toBeUndefined()
})
