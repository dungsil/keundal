import { EventType, STREAM_LIMITS, StreamBudget, fetchWithStreamLimit } from '@keundal/core'
import { expect, test, vi } from 'vitest'

test('중첩 메타데이터와 큰 문자열을 직렬화하지 않고 거부한다', () => {
  const budget = new StreamBudget()
  const serialize = vi.fn(() => {
    throw new Error('must not serialize')
  })
  expect(() => budget.accept({ value: 'x'.repeat(STREAM_LIMITS.eventBytes + 1), toJSON: serialize })).toThrow(
    'custom stream serialization'
  )
  expect(serialize).not.toHaveBeenCalled()
  expect(() => budget.accept({ nested: { value: 'x'.repeat(STREAM_LIMITS.eventBytes + 1) } })).toThrow(
    'stream byte limit'
  )
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  expect(() => budget.accept(cycle)).toThrow('cyclic stream payload')
  let deep: unknown = {}
  for (let i = 0; i < STREAM_LIMITS.depth + 1; i++) deep = { value: deep }
  expect(() => budget.accept(deep)).toThrow('stream structure limit')
  expect(() => budget.accept(Array(STREAM_LIMITS.nodes + 1).fill(null))).toThrow('stream structure limit')
})

test('빈 이벤트와 작은 조각의 누적 개수 및 바이트를 제한한다', () => {
  const events = new StreamBudget()
  for (let i = 0; i < STREAM_LIMITS.events; i++) events.accept({})
  expect(() => events.accept({})).toThrow('stream event limit')
  const bytes = new StreamBudget()
  const delta = 'x'.repeat(1024 * 1024)
  for (let i = 0; i < 31; i++) bytes.accept({ delta })
  expect(() => bytes.accept({ delta })).toThrow('stream byte limit')
})

test('일반 텍스트와 제어 문자·유니코드·서로게이트를 보존하며 실행별 예산을 분리한다', () => {
  for (let run = 0; run < 2; run++) {
    const budget = new StreamBudget()
    budget.accept({ type: EventType.TEXT_MESSAGE_CONTENT, delta: '한국어 😀 \\"\n\u0000\ud800' })
    budget.accept({ metadata: { citations: [{ url: 'https://example.com', title: '자료' }] } })
  }
  expect(() => new StreamBudget().accept('\u0000'.repeat(STREAM_LIMITS.eventBytes / 4))).toThrow('stream byte limit')
})

test.for([false, true])('공급자 응답의 %s 단일 청크 초과를 SDK에 넘기기 전에 취소한다', async (single, t) => {
  let cancelled = false
  const chunk = new Uint8Array(single ? STREAM_LIMITS.bytes + 1 : 1024 * 1024)
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new globalThis.Response(
      new globalThis.ReadableStream({
        pull(controller) {
          controller.enqueue(chunk)
        },
        cancel() {
          cancelled = true
        }
      })
    )
  )
  t.onTestFinished(() => fetch.mockRestore())
  const response = await fetchWithStreamLimit('https://example.com')
  const reader = response.body!.getReader()
  let accepted = 0
  await expect(
    (async () => {
      while (true) {
        const next = await reader.read()
        if (next.done) return
        accepted += next.value.byteLength
      }
    })()
  ).rejects.toThrow('provider response byte limit')
  expect(accepted).toBe(single ? 0 : STREAM_LIMITS.bytes)
  expect(cancelled).toBe(true)
})

test('정상 응답의 상태와 헤더를 보존하고 소비자의 취소를 전달한다', async (t) => {
  let cancelled = false
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new globalThis.Response(
      new globalThis.ReadableStream({
        pull(controller) {
          controller.enqueue(new globalThis.TextEncoder().encode('ok'))
        },
        cancel() {
          cancelled = true
        }
      }),
      { status: 201, headers: { 'x-test': 'yes' } }
    )
  )
  t.onTestFinished(() => fetch.mockRestore())
  const response = await fetchWithStreamLimit('https://example.com')
  expect(response.status).toBe(201)
  expect(response.headers.get('x-test')).toBe('yes')
  const reader = response.body!.getReader()
  expect(new globalThis.TextDecoder().decode((await reader.read()).value)).toBe('ok')
  await reader.cancel()
  expect(cancelled).toBe(true)
})

test('희소 배열의 빈 원소도 JSON null 크기로 예산에 포함한다', () => {
  const budget = new StreamBudget()
  const sparse: unknown[] = []
  sparse.length = 200_000
  for (let i = 0; i < 6; i++) budget.accept(sparse)
  expect(() => budget.accept(sparse)).toThrow('stream byte limit')
})
