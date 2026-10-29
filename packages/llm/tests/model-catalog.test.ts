import { MODEL_CATALOG_LIMITS, ModelCatalogBudget, parseModelCapabilities, listModelsDevModels } from '@keundal/llm'
import { expect, test, vi, onTestFinished } from 'vitest'

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

test('models.dev의 공급자별 가격과 서로 다른 context·input·output 한도를 매핑한다', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      openai: {
        models: {
          shared: {
            name: 'Official',
            limit: { context: 200000, input: 180000, output: 16000 },
            cost: { input: 3, output: 15, cache_read: 0, cache_write: 3.75 }
          }
        }
      },
      other: { models: { shared: { cost: { input: 99 } } } }
    })
  )
  onTestFinished(() => fetch.mockRestore())
  expect(await listModelsDevModels('openai')).toEqual([
    {
      id: 'shared',
      name: 'Official',
      contextWindow: 200000,
      maxInputTokens: 180000,
      maxOutputTokens: 16000,
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 3.75 }
    }
  ])
  expect(await listModelsDevModels('missing')).toEqual([])
  expect(await listModelsDevModels('constructor')).toEqual([])
})

test('models.dev의 잘못된 한도와 가격을 미상으로 두고 누락된 캐시 가격을 무료로 처리하지 않는다', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      vendor: {
        models: {
          broken: {
            limit: { context: -1, input: 1.5, output: '100' },
            cost: { input: -2, output: 0, cache_read: '0.5' }
          },
          unknown: {},
          ignored: null
        }
      }
    })
  )
  onTestFinished(() => fetch.mockRestore())
  expect(await listModelsDevModels('vendor')).toEqual([
    {
      id: 'broken',
      name: 'broken',
      contextWindow: undefined,
      maxInputTokens: undefined,
      maxOutputTokens: undefined,
      cost: { input: undefined, output: 0, cacheRead: undefined, cacheWrite: undefined }
    },
    { id: 'unknown', name: 'unknown', contextWindow: undefined, maxInputTokens: undefined, maxOutputTokens: undefined }
  ])
})
