import { MODEL_CATALOG_LIMITS } from '@keundal/llm'
import { listAnthropicModels } from '@keundal/plugin-llm-anthropic'
import { expect, test, vi } from 'vitest'

test('큰 모델 응답과 긴 식별자를 거부하고 정상 모델을 보존한다', async (t) => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  t.onTestFinished(() => fetch.mockRestore())
  fetch.mockResolvedValueOnce(new Response(' '.repeat(MODEL_CATALOG_LIMITS.pageBytes + 1)))
  await expect(listAnthropicModels({ apiKey: '' })).rejects.toThrow('byte limit')
  fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 'x'.repeat(1025) }] }))
  await expect(listAnthropicModels({ apiKey: '' })).rejects.toThrow()
  fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 'test' }] }))
  expect(await listAnthropicModels({ apiKey: '' })).toEqual([
    { id: 'test', name: 'test', contextWindow: undefined, maxOutputTokens: undefined }
  ])
})

test('중복 모델도 원본 항목 개수 한도에 포함한다', async (t) => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ data: Array.from({ length: 4097 }, () => ({ id: 'test' })) }))
  t.onTestFinished(() => fetch.mockRestore())
  await expect(listAnthropicModels({ apiKey: '' })).rejects.toThrow('entry limit')
})

test('서로 다른 커서로 빈 페이지를 반환해도 페이지 한도에서 중단한다', async (t) => {
  let pages = 0
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ data: [], has_more: true, last_id: String(++pages) }))
  t.onTestFinished(() => fetch.mockRestore())
  await expect(listAnthropicModels({ apiKey: '' })).rejects.toThrow('page limit')
  expect(pages).toBe(MODEL_CATALOG_LIMITS.pages)
})

test('중복되거나 제외되는 모델도 페이지 전체의 누적 항목 한도에 포함한다', async (t) => {
  let pages = 0
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      data: Array.from({ length: 1024 }, () => ({ id: 'duplicate' })),
      has_more: true,
      last_id: String(++pages)
    })
  )
  t.onTestFinished(() => fetch.mockRestore())
  await expect(listAnthropicModels({ apiKey: '' })).rejects.toThrow('entry limit')
  expect(pages).toBe(5)
})
test('긴 페이지 커서는 다음 요청 전에 거부한다', async (t) => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ data: [], has_more: true, last_id: 'x'.repeat(2049) }))
  t.onTestFinished(() => fetch.mockRestore())
  await expect(listAnthropicModels({ apiKey: '' })).rejects.toThrow()
  expect(fetch).toHaveBeenCalledOnce()
})
