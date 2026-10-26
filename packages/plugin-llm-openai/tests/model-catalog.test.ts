import { MODEL_CATALOG_LIMITS } from '@keundal/llm'
import { listOpenAIModels } from '@keundal/plugin-llm-openai'
import { expect, test, vi } from 'vitest'

test('큰 모델 응답과 긴 식별자를 거부하고 정상 모델을 보존한다', async (t) => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  t.onTestFinished(() => fetch.mockRestore())
  fetch.mockResolvedValueOnce(new Response(' '.repeat(MODEL_CATALOG_LIMITS.pageBytes + 1)))
  await expect(listOpenAIModels({ apiKey: '' })).rejects.toThrow('byte limit')
  fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 'x'.repeat(1025) }] }))
  await expect(listOpenAIModels({ apiKey: '' })).rejects.toThrow()
  fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 'test' }] }))
  expect(await listOpenAIModels({ apiKey: '' })).toEqual([
    { id: 'test', name: 'test', contextWindow: undefined, maxOutputTokens: undefined }
  ])
})

test('중복 모델도 원본 항목 개수 한도에 포함한다', async (t) => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ data: Array.from({ length: 4097 }, () => ({ id: 'test' })) }))
  t.onTestFinished(() => fetch.mockRestore())
  await expect(listOpenAIModels({ apiKey: '' })).rejects.toThrow('entry limit')
})
