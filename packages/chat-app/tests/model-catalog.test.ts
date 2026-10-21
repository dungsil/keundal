import { createServer } from 'node:http'
import { effectScope, ref } from 'vue'
import { expect, onTestFinished, test, vi } from 'vitest'
import { defaultLLMSettings } from '@keundal/llm-settings'
import * as modelRequests from '@keundal/plugin-llm-browser/models'
import { useModelCatalog } from '../app/composables/useModelCatalog'
import { translate } from '../../../packages/ui/app/utils/locale'

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
  const catalog = scope.run(() => useModelCatalog(settings, (...args) => modelRequests.loadModels(...args)))!
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
  settings.value['openai@work'] = { name: 'Work', apiKey: '', baseURL: `http://127.0.0.1:${address.port}` }
  await vi.waitFor(() => expect(catalog.models.value.map(model => model.value)).toEqual(['openai@work/local-model']))
  expect(values.has('keundal:models:openai@work')).toBe(true)
  delete settings.value['openai@work']
  await vi.waitFor(() => {
    expect(catalog.models.value).toEqual([])
    expect(values.has('keundal:models:openai@work')).toBe(false)
  })
})

test('모델 조회의 일반 오류는 현재 표시 언어를 따르고 공급자 진단은 유지한다', async () => {
  const request = vi.spyOn(modelRequests, 'loadModels').mockRejectedValue('unknown failure')
  vi.stubGlobal('localStorage', { removeItem: vi.fn() })
  const scope = effectScope()
  onTestFinished(() => {
    scope.stop()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const settings = ref(defaultLLMSettings())
  settings.value.openai.baseURL = 'http://localhost:1234'
  const locale = ref<'en' | 'ko'>('ko')
  const catalog = scope.run(() => useModelCatalog(settings, (...args) => modelRequests.loadModels(...args), () => translate(locale.value, 'model.loadFailed')))!

  await vi.waitFor(() => expect(catalog.loading.value).toBe(false))
  expect(catalog.error.value.trim()).toBe('모델 목록을 불러오지 못했습니다.')

  locale.value = 'en'
  await catalog.refresh(true)
  expect(catalog.error.value.trim()).toBe('Could not load models')

  request.mockRejectedValueOnce(new Error('Provider diagnostic'))
  await catalog.refresh(true)
  expect(catalog.error.value.trim()).toBe('Provider diagnostic')
})
