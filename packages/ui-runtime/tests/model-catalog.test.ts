import { createServer } from 'node:http'
import { effectScope, ref } from 'vue'
import { expect, onTestFinished, test, vi } from 'vitest'
import { defaultLLMSettings } from '@keundal/llm-settings'
import * as modelRequests from '@keundal/browser-composition/llm'
import type { ModelOption } from '@keundal/chat/models'
import { useModelCatalog } from '../src/model-catalog'

test('API 주소가 있는 공급자와 인증 없는 목업의 모델을 조회하고 삭제 시 목록과 캐시를 비운다', async () => {
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
  expect(catalog.loading.value).toBe(true)
  // Join the watcher-started request instead of imposing waitFor's one-second deadline on HTTP.
  await catalog.refresh()
  expect(catalog.error.value).toBe('')
  expect(catalog.models.value.map(model => model.value)).toEqual(['openai/local-model'])
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
  expect(catalog.loading.value).toBe(true)
  await catalog.refresh()
  expect(catalog.error.value).toBe('')
  expect(catalog.models.value.map(model => model.value)).toEqual(['openai@work/local-model'])
  expect(values.has('keundal:models:openai@work')).toBe(true)
  delete settings.value['openai@work']
  await vi.waitFor(() => {
    expect(catalog.models.value).toEqual([])
    expect(values.has('keundal:models:openai@work')).toBe(false)
  })
  settings.value['mock@demo'] = { name: 'Mock LLM', apiKey: '', baseURL: '' }
  await catalog.refresh()
  expect(catalog.error.value).toBe('')
  expect(catalog.models.value.map(model => model.value)).toEqual([
    'mock@demo/mock-text', 'mock@demo/mock-tool', 'mock@demo/mock-error', 'mock@demo/mock-slow'
  ])
  expect(values.has('keundal:models:mock@demo')).toBe(true)
  delete settings.value['mock@demo']
  await catalog.refresh()
  expect(catalog.models.value).toEqual([])
  expect(values.has('keundal:models:mock@demo')).toBe(false)
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
  const catalog = scope.run(() => useModelCatalog(settings, (...args) => modelRequests.loadModels(...args), () => ({ ko: '모델 목록을 불러오지 못했습니다.', en: 'Could not load models' })[locale.value]))!

  await vi.waitFor(() => expect(catalog.loading.value).toBe(false))
  expect(catalog.error.value.trim()).toBe('모델 목록을 불러오지 못했습니다.')

  locale.value = 'en'
  await catalog.refresh(true)
  expect(catalog.error.value.trim()).toBe('Could not load models')

  request.mockRejectedValueOnce(new Error('Provider diagnostic'))
  await catalog.refresh(true)
  expect(catalog.error.value.trim()).toBe('Provider diagnostic')
})

test('공급자별 응답을 즉시 표시하고 동시 새로고침은 같은 요청을 기다린다', async () => {
  vi.stubGlobal('localStorage', { removeItem: vi.fn() })
  const scope = effectScope()
  onTestFinished(() => { scope.stop(); vi.unstubAllGlobals() })
  const settings = ref(defaultLLMSettings())
  settings.value.openai.apiKey = 'key'
  settings.value.google.apiKey = 'key'
  const openai = Promise.withResolvers<ModelOption[]>()
  const google = Promise.withResolvers<ModelOption[]>()
  const loader = vi.fn((provider: string) => provider === 'openai' ? openai.promise : google.promise)
  const catalog = scope.run(() => useModelCatalog(settings, loader))!
  const first = catalog.refresh()
  expect(catalog.refresh()).toBe(first)
  expect(loader).toHaveBeenCalledTimes(2)
  openai.resolve([{ value: 'openai/fast', label: 'Fast', icon: '' }])
  await vi.waitFor(() => expect(catalog.models.value.map(item => item.value)).toEqual(['openai/fast']))
  expect(catalog.loading.value).toBe(true)
  google.resolve([{ value: 'google/slow', label: 'Slow', icon: '' }])
  await first
  expect(catalog.models.value.map(item => item.value)).toEqual(['google/slow', 'openai/fast'])
  expect(catalog.loading.value).toBe(false)
})

test('설정 변경 전 늦은 응답과 범위 해제 후 응답은 새 목록을 덮어쓰지 않는다', async () => {
  vi.stubGlobal('localStorage', { removeItem: vi.fn() })
  const scope = effectScope()
  onTestFinished(() => { scope.stop(); vi.unstubAllGlobals() })
  const settings = ref(defaultLLMSettings())
  settings.value.openai.apiKey = 'old'
  const old = Promise.withResolvers<ModelOption[]>()
  const next = Promise.withResolvers<ModelOption[]>()
  const loader = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const catalog = scope.run(() => useModelCatalog(settings, loader))!
  settings.value.openai.apiKey = 'new'
  expect(loader.mock.calls[0]![1].openai.apiKey).toBe('old')
  expect(loader.mock.calls[0]![3].signal.aborted).toBe(true)
  next.resolve([{ value: 'openai/new', label: 'New', icon: '' }])
  await catalog.refresh()
  old.resolve([{ value: 'openai/old', label: 'Old', icon: '' }])
  await old.promise
  expect(catalog.models.value[0]!.value).toBe('openai/new')
  const disposed = Promise.withResolvers<ModelOption[]>()
  loader.mockReturnValueOnce(disposed.promise)
  const pending = catalog.refresh(true)
  scope.stop()
  disposed.resolve([])
  await pending
  expect(catalog.models.value[0]!.value).toBe('openai/new')
})


test('강제 갱신은 진행 중인 일반 조회를 취소하고 강제 요청끼리만 합친다', async () => {
  vi.stubGlobal('localStorage', { removeItem: vi.fn() })
  const scope = effectScope()
  onTestFinished(() => { scope.stop(); vi.unstubAllGlobals() })
  const settings = ref(defaultLLMSettings())
  settings.value.openai.apiKey = 'key'
  settings.value.google.apiKey = 'key'
  const slow = Promise.withResolvers<ModelOption[]>()
  const fresh = Promise.withResolvers<ModelOption[]>()
  const loader = vi.fn((provider: string, _settings: unknown, _storage: unknown, options?: { force?: boolean }) => {
    if (options?.force) return fresh.promise
    return provider === 'openai' ? Promise.resolve([{ value: 'openai/cached', label: 'Cached', icon: '' }]) : slow.promise
  })
  const catalog = scope.run(() => useModelCatalog(settings, loader))!
  await vi.waitFor(() => expect(catalog.models.value[0]?.value).toBe('openai/cached'))
  const pending = catalog.refresh(true)
  expect(catalog.refresh(true)).toBe(pending)
  expect(loader).toHaveBeenCalledTimes(4)
  fresh.resolve([])
  await pending
  slow.resolve([{ value: 'google/old', label: 'Old', icon: '' }])
  await slow.promise
  expect(catalog.models.value).toEqual([])
})
