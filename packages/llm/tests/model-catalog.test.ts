import { MODEL_CATALOG_LIMITS, ModelCatalogBudget } from '@keundal/llm'
import { expect, test, vi } from 'vitest'

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
