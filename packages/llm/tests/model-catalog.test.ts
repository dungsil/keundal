import { MODEL_CATALOG_LIMITS, ModelCatalogBudget, parseModelCapabilities } from '@keundal/llm'
import { expect, test, vi } from 'vitest'

test('모델 기능 메타데이터의 생략과 빈 값 및 모든 reasoning 값을 보존한다', () => {
  expect(parseModelCapabilities(undefined)).toBeUndefined()
  expect(parseModelCapabilities({})).toStrictEqual({})
  expect(parseModelCapabilities({ reasoning: [] })).toStrictEqual({ reasoning: [] })
  const capabilities = {
    tools: false,
    reasoning: [false, true, 'low', 'medium', 'high', 'xhigh', 'max'],
    webSearch: true
  }
  expect(parseModelCapabilities(capabilities)).toStrictEqual(capabilities)
  expect(parseModelCapabilities({ tools: true, webSearch: false })).toStrictEqual({ tools: true, webSearch: false })
})

test('모델 기능 메타데이터의 잘못된 형식과 알 수 없는 키 및 reasoning 항목을 거부한다', () => {
  for (const value of [
    null,
    [],
    true,
    'tools',
    { tools: 'true' },
    { webSearch: 1 },
    { reasoning: true },
    { reasoning: [undefined] },
    { reasoning: Array(1) },
    { reasoning: [null] },
    { reasoning: ['invalid'] },
    { reasoning: [1] },
    { unknown: true },
    { [Symbol('tools')]: true }
  ])
    expect(() => parseModelCapabilities(value)).toThrow()
})

test.each([200, 400])('HTTP %s 응답의 실제 바이트가 한도를 넘으면 JSON을 해석하기 전에 취소한다', async (status) => {
  const cancel = vi.fn()
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(65536))
      },
      cancel
    }),
    { status, headers: { 'content-length': '1' } }
  )
  await expect(new ModelCatalogBudget().readJSON(response)).rejects.toThrow('byte limit')
  expect(cancel).toHaveBeenCalledOnce()
})

test('페이지별로 허용되는 응답도 전체 바이트 한도를 넘으면 거부한다', async () => {
  const budget = new ModelCatalogBudget()
  const body = JSON.stringify('x'.repeat(MODEL_CATALOG_LIMITS.pageBytes - 2))
  for (let i = 0; i < 8; i++) await budget.readJSON(new Response(body))
  await expect(budget.readJSON(new Response('null'))).rejects.toThrow('byte limit')
})

test('알 수 없는 메타데이터의 깊이와 누적 노드 수를 제한한다', async () => {
  const deep = '['.repeat(18) + '0' + ']'.repeat(18)
  await expect(new ModelCatalogBudget().readJSON(new Response(deep))).rejects.toThrow('structure limit')
  const budget = new ModelCatalogBudget()
  const body = JSON.stringify(Array(65536).fill(0))
  for (let i = 0; i < 3; i++) await budget.readJSON(new Response(body))
  await expect(budget.readJSON(new Response(body))).rejects.toThrow('structure limit')
})

test('정상 유니코드 JSON을 분할 청크에서도 보존한다', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ name: '한국어 😀' }))
  let offset = 0
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close()
        else controller.enqueue(bytes.slice(offset, ++offset))
      }
    })
  )
  await expect(new ModelCatalogBudget().readJSON(response)).resolves.toEqual({ name: '한국어 😀' })
})
