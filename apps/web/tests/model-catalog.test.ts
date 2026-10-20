import { createServer } from 'node:http'
import { effectScope, ref } from 'vue'
import { expect, onTestFinished, test, vi } from 'vitest'
import { defaultLLMSettings } from '../shared/utils/llm-settings'
import { useModelCatalog } from '../app/composables/useModelCatalog'

vi.mock('#shared/utils/llm-settings', async () => import('../shared/utils/llm-settings'))
vi.mock('#shared/utils/models', async () => import('../shared/utils/models'))

test('API 키 없이 주소만 저장한 공급자의 모델을 조회하고 설정 삭제 시 목록과 캐시를 비운다', async () => {
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url!)
    expect(req.headers.authorization).toBeUndefined()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'local-model' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  })
  const scope = effectScope()
  onTestFinished(() => {
    scope.stop()
    vi.unstubAllGlobals()
  })
  const settings = ref(defaultLLMSettings())
  const catalog = scope.run(() => useModelCatalog(settings))!
  await vi.waitFor(() => expect(catalog.loading.value).toBe(false))
  expect(paths).toEqual([])
  settings.value.openai.baseURL = `http://127.0.0.1:${address.port}`
  await vi.waitFor(() => expect(catalog.models.value.map(model => model.value)).toEqual(['openai/local-model']))
  expect(paths).toEqual(['/models'])
  expect(values.has('keundal:models:openai')).toBe(true)
  settings.value = defaultLLMSettings()
  await vi.waitFor(() => {
    expect(catalog.loading.value).toBe(false)
    expect(catalog.models.value).toEqual([])
    expect(values.has('keundal:models:openai')).toBe(false)
  })
  expect(paths).toEqual(['/models'])
})
