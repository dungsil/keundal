import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { listAnthropicModels } from '@keundal/plugin-llm-anthropic'
import { listGeminiModels } from '@keundal/plugin-llm-gemini'
import { listOpenAIModels } from '@keundal/plugin-llm-openai'
import { listOpenAIChatModels } from '@keundal/plugin-llm-openai-chat'
import { expect, test, onTestFinished, vi } from 'vitest'
import { MODEL_CACHE_TTL, MODEL_CACHE_MAX_AGE } from '@keundal/plugin-llm-browser/models'
import { loadModels } from '@keundal/browser-composition/llm'
import { defaultLLMSettings, llmSettingsSchema } from '@keundal/llm-settings'

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: IncomingMessage[] = []
  const server = createServer((req, res) => {
    requests.push(req)
    res.setHeader('content-type', 'application/json')
    handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
  const settings = defaultLLMSettings()
  for (const provider of ['openai', 'openai-chat', 'anthropic', 'google'] as const)
    settings[provider] = { apiKey: `private-${provider}`, baseURL: `http://127.0.0.1:${address.port}/gateway` }
  return { requests, settings, storage, values }
}

test.each([
  { provider: 'openai' as const, list: listOpenAIModels, suffix: '/models' },
  { provider: 'openai-chat' as const, list: listOpenAIChatModels, suffix: '/models' },
  { provider: 'anthropic' as const, list: listAnthropicModels, suffix: '/v1/models?limit=1000' },
  { provider: 'google' as const, list: listGeminiModels, suffix: '/v1beta/models' }
])('$provider 모델 조회는 경로 내부의 슬래시를 보존하고 끝의 슬래시만 모두 제거한다', async ({ provider, list, suffix }) => {
  const { requests, settings } = await fixture((_req, res) => {
    res.end(JSON.stringify(provider === 'google'
      ? { models: [{ name: 'models/test-model', displayName: 'Test Model', supportedGenerationMethods: ['generateContent'] }] }
      : { data: [{ id: 'test-model', display_name: 'Test Model' }] }))
  })
  for (const trailing of ['', '/', '///']) {
    const models = await list({ ...settings[provider], baseURL: `${settings[provider].baseURL}/nested///path${trailing}` })
    expect(requests.at(-1)!.url).toBe(`/gateway/nested///path${suffix}`)
    expect(models).toEqual([{ id: 'test-model', name: 'Test Model', contextWindow: undefined, maxOutputTokens: undefined }])
  }
})

test.each(['openai', 'openai-chat', 'anthropic', 'google'] as const)('%s 모델의 명시된 기능을 캐시에서도 보존하고 없는 기능은 추정하지 않는다', async (provider) => {
  const capabilities = { tools: true, reasoning: ['low', 'high'], webSearch: false }
  const entries = [
    { id: 'declared', capabilities },
    { id: 'unknown' },
    { id: 'unrelated', capabilities: { imageInput: { supported: true } } }
  ]
  const { settings, storage } = await fixture((_req, res) => {
    res.end(JSON.stringify(provider === 'google'
      ? { models: entries.map(({ id, ...metadata }) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'], ...metadata })) }
      : { data: entries }))
  })
  const models = await loadModels(provider, settings, storage)
  expect(models[0]!.capabilities).toEqual(capabilities)
  expect(models[1]!.capabilities).toBeUndefined()
  expect(models[2]!.capabilities).toBeUndefined()
  expect(await loadModels(provider, settings, storage)).toEqual(models)
})

test('모델 캐시는 한 시간 미만에 재사용하고 만료·강제 갱신·키·주소 변경 시 다시 불러온다', async () => {
  const { settings, storage, requests, values } = await fixture((req, res) => {
    res.end(JSON.stringify({ data: [{ id: req.headers.authorization === 'Bearer changed-key' ? 'new-model' : 'old-model' }] }))
  })
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
  onTestFinished(() => now.mockRestore())
  const first = await loadModels('openai', settings, storage)
  expect(first.map(model => model.value)).toEqual(['openai/old-model'])
  expect(requests[0]!.url).toBe('/gateway/models')
  expect(requests[0]!.headers.authorization).toBe('Bearer private-openai')
  expect([...values.values()].join()).not.toContain('private-openai')
  now.mockReturnValue(100_000 + MODEL_CACHE_TTL - 1)
  expect(await loadModels('openai', settings, storage)).toEqual(first)
  expect(requests).toHaveLength(1)
  now.mockReturnValue(100_000 + MODEL_CACHE_TTL)
  await loadModels('openai', settings, storage)
  expect(requests).toHaveLength(2)
  await loadModels('openai', settings, storage, { force: true })
  expect(requests).toHaveLength(3)
  settings.openai.apiKey = 'changed-key'
  expect((await loadModels('openai', settings, storage))[0]!.value).toBe('openai/new-model')
  settings.openai.baseURL += '/other'
  await loadModels('openai', settings, storage)
  expect(requests).toHaveLength(5)
  expect(requests[4]!.url).toBe('/gateway/other/models')
  settings.openai.headers = { 'X-Gateway-Token': 'private-gateway', 'Authorization': 'Bearer custom-auth' }
  await loadModels('openai', settings, storage)
  expect(requests).toHaveLength(6)
  expect(requests[5]!.headers['x-gateway-token']).toBe('private-gateway')
  expect(requests[5]!.headers.authorization).toBe('Bearer custom-auth')
  expect([...values.values()].join()).not.toContain('private-gateway')
  settings.openai.headers = { 'authorization': 'Bearer custom-auth', 'x-gateway-token': 'private-gateway' }
  await loadModels('openai', settings, storage)
  expect(requests).toHaveLength(6)
})

test.each(['anthropic', 'google'] as const)('%s 모델 목록의 모든 페이지를 병합하고 공급자 인증과 모델 한도를 보존한다', async (provider) => {
  const { settings, storage, requests } = await fixture((req, res) => {
    const second = req.url!.includes(provider === 'google' ? 'pageToken=next' : 'after_id=next')
    res.end(JSON.stringify(provider === 'google'
      ? { models: [{ name: `models/model-${second ? 2 : 1}`, displayName: `Model ${second ? 2 : 1}`, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 32768, outputTokenLimit: 8192 }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], ...(!second ? { nextPageToken: 'next' } : {}) }
      : { data: [{ id: `model-${second ? 2 : 1}`, display_name: `Model ${second ? 2 : 1}`, max_input_tokens: 32768, max_tokens: 8192 }], has_more: !second, last_id: second ? 'end' : 'next' }))
  })
  settings[provider].headers = { 'X-Gateway-Token': 'private-gateway' }
  const models = await loadModels(provider, settings, storage)
  expect(models.map(model => model.value)).toEqual([`${provider}/model-1`, `${provider}/model-2`])
  expect(models[1]).toMatchObject({ label: 'Model 2', contextWindow: 32768, maxOutputTokens: 8192 })
  expect(requests).toHaveLength(2)
  expect(requests.every(request => request.headers['x-gateway-token'] === 'private-gateway')).toBe(true)
  expect(requests[0]!.url).toBe(provider === 'google' ? '/gateway/v1beta/models' : '/gateway/v1/models?limit=1000')
  expect(requests[0]!.headers[provider === 'google' ? 'x-goog-api-key' : 'x-api-key']).toBe(`private-${provider}`)
  if (provider === 'anthropic') expect(requests[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
  expect(await loadModels(provider, settings, storage)).toEqual(models)
  expect(requests).toHaveLength(2)
})

test('실패한 모델 조회는 키가 포함된 응답을 노출하거나 캐시하지 않고 다음 시도에서 복구한다', async () => {
  let fail = true
  const { settings, storage, values } = await fixture((_req, res) => {
    if (fail) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Incorrect key private-openai' }))
    } else res.end(JSON.stringify({ data: [{ id: 'available' }] }))
  })
  const failure = await loadModels('openai', settings, storage).catch(error => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure.message).toContain('HTTP 401')
  expect(failure.message).not.toContain('private-openai')
  expect(values.size).toBe(0)
  fail = false
  expect((await loadModels('openai', settings, storage))[0]!.value).toBe('openai/available')
})

test.each([
  { body: { error: { message: 'Invalid region; key=private-openai; header=private-gateway' } }, detail: 'Invalid region' },
  { body: { message: 'Invalid API version' }, detail: 'Invalid API version' },
  { body: 'not JSON', detail: 'Check your API key' }
])('400 모델 조회 오류의 원인은 표시하고 키·헤더는 숨기며 잘못된 본문은 일반 안내로 대체한다: $detail', async ({ body, detail }) => {
  const { settings, storage } = await fixture((_req, res) => {
    res.writeHead(400)
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  settings.openai.headers = { 'X-Gateway-Token': 'private-gateway' }
  const error = await loadModels('openai', settings, storage).catch(error => error)
  expect(error.message).toContain('HTTP 400')
  expect(error.message).toContain(detail)
  expect(error.message).not.toContain('private-openai')
  expect(error.message).not.toContain('private-gateway')
})

test('취소한 모델 조회는 결과를 캐시하지 않는다', async () => {
  const started = Promise.withResolvers<undefined>()
  const { settings, storage, values } = await fixture(() => {
    started.resolve(undefined)
  })
  const controller = new AbortController()
  const pending = loadModels('openai', settings, storage, { signal: controller.signal })
  const cancelled = expect(pending).rejects.toThrow('settings changed')
  await started.promise
  controller.abort(new Error('settings changed'))
  await cancelled
  expect(values.size).toBe(0)
})

test.each(['openai', 'openai-chat', 'anthropic', 'google'] as const)('%s 모델 목록은 빈 API 키일 때 기본 인증을 생략하고 커스텀 인증과 캐시 전환을 지원한다', async (provider) => {
  const { settings, storage, requests } = await fixture((_req, res) => {
    res.end(JSON.stringify(provider === 'google'
      ? { models: [{ name: 'models/local', supportedGenerationMethods: ['generateContent'] }] }
      : { data: [{ id: 'local' }] }))
  })
  settings[provider].apiKey = ''
  expect((await loadModels(provider, settings, storage))[0]!.value).toBe(`${provider}/local`)
  expect(requests).toHaveLength(1)
  for (const header of ['authorization', 'x-api-key', 'x-goog-api-key']) expect(requests[0]!.headers[header]).toBeUndefined()
  await loadModels(provider, settings, storage)
  expect(requests).toHaveLength(1)
  settings[provider].apiKey = 'new-key'
  await loadModels(provider, settings, storage)
  expect(requests).toHaveLength(2)
  settings[provider].apiKey = ''
  settings[provider].headers = { Authorization: 'Bearer gateway-token' }
  await loadModels(provider, settings, storage)
  expect(requests).toHaveLength(3)
  expect(requests[2]!.headers.authorization).toBe('Bearer gateway-token')
  expect(requests[2]!.headers['x-api-key']).toBeUndefined()
  expect(requests[2]!.headers['x-goog-api-key']).toBeUndefined()
})

test('같은 종류의 공급자는 모델 ID가 같아도 인증·모델 선택·캐시를 분리한다', async () => {
  const { settings, storage, requests, values } = await fixture((_req, res) => {
    res.end(JSON.stringify({ data: [{ id: 'shared/model' }] }))
  })
  settings['openai@work'] = { ...settings.openai, name: 'Work', apiKey: 'work-key' }
  settings['openai@home'] = { ...settings.openai, name: 'Home', apiKey: 'home-key' }
  const work = await loadModels('openai@work', settings, storage)
  const home = await loadModels('openai@home', settings, storage)
  expect(work[0]).toMatchObject({ value: 'openai@work/shared/model', label: 'shared/model · Work' })
  expect(home[0]).toMatchObject({ value: 'openai@home/shared/model', label: 'shared/model · Home' })
  expect(requests.map(request => request.headers.authorization)).toEqual(['Bearer work-key', 'Bearer home-key'])
  await loadModels('openai@work', settings, storage)
  await loadModels('openai@home', settings, storage)
  expect(requests).toHaveLength(2)
  expect(values.size).toBe(2)
  expect([...values.values()].join('')).not.toContain('work-key')
})

test.each(['openai', 'openai-chat', 'anthropic', 'google'] as const)('%s의 한도를 넘는 모델 목록은 캐시하지 않는다', async (provider) => {
  const { settings, storage, values } = await fixture((_req, res) => {
    res.end(' '.repeat(1024 * 1024 + 1))
  })
  await expect(loadModels(provider, settings, storage)).rejects.toThrow()
  expect(values.size).toBe(0)
})


test('갱신 실패 시 같은 설정의 캐시만 최대 수명까지 재사용하고 시계 역행은 거부한다', async () => {
  let fail = false
  const { settings, storage } = await fixture((_req, res) => {
    res.statusCode = fail ? 503 : 200
    res.end(JSON.stringify({ data: [{ id: 'cached' }] }))
  })
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
  onTestFinished(() => now.mockRestore())
  const first = await loadModels('openai', settings, storage)
  fail = true
  now.mockReturnValue(100_000 + MODEL_CACHE_TTL)
  expect(await loadModels('openai', settings, storage)).toEqual(first)
  now.mockReturnValue(100_000 + MODEL_CACHE_MAX_AGE)
  await expect(loadModels('openai', settings, storage)).rejects.toThrow()
  fail = false
  now.mockReturnValue(100_000)
  await loadModels('openai', settings, storage)
  fail = true
  now.mockReturnValue(99_999)
  await expect(loadModels('openai', settings, storage)).rejects.toThrow()
})

test('이전 인증 설정의 늦은 응답은 새 설정의 저장된 캐시를 덮어쓰지 않는다', async () => {
  const delayed = Promise.withResolvers<ServerResponse>()
  const { settings, storage, requests } = await fixture((req, res) => {
    if (req.headers.authorization === 'Bearer private-openai') delayed.resolve(res)
    else res.end(JSON.stringify({ data: [{ id: 'new' }] }))
  })
  const old = loadModels('openai', settings, storage)
  const response = await delayed.promise
  settings.openai.apiKey = 'new'
  const next = await loadModels('openai', settings, storage)
  response.end(JSON.stringify({ data: [{ id: 'old' }] }))
  await old
  expect(await loadModels('openai', settings, storage)).toEqual(next)
  expect(requests).toHaveLength(2)
})

test.each(['openai', 'openai-chat', 'anthropic', 'google'] as const)('%s 공식 API의 모델 메타데이터를 models.dev에서 채우고 캐시에 보존한다', async (provider) => {
  const { settings, storage } = await fixture((_req, res) => res.end('{}'))
  settings[provider].baseURL = ''
  let publicHeaders: Headers | undefined
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === 'https://models.dev/api.json') {
      publicHeaders = new Headers(init?.headers)
      return Response.json(Object.fromEntries(['openai', 'anthropic', 'google'].map((id, i) => [id, {
        models: { shared: { name: id, limit: { context: 200000 + i, input: 180000, output: 16000 }, cost: { input: i + 1, output: 15, cache_read: 0, cache_write: 3.75 } } }
      }])))
    }
    return Response.json(provider === 'google'
      ? { models: [{ name: 'models/shared', supportedGenerationMethods: ['generateContent'] }, { name: 'models/unknown', supportedGenerationMethods: ['generateContent'] }] }
      : { data: [{ id: 'shared' }, { id: 'unknown' }] })
  })
  onTestFinished(() => fetch.mockRestore())
  const vendor = provider === 'openai-chat' ? 'openai' : provider
  const index = ['openai', 'anthropic', 'google'].indexOf(vendor)
  const models = await loadModels(provider, settings, storage)
  expect(models[0]).toMatchObject({
    value: `${provider}/shared`, label: vendor, contextWindow: 200000 + index, maxInputTokens: 180000, maxOutputTokens: 16000,
    cost: { input: index + 1, output: 15, cacheRead: 0, cacheWrite: 3.75 }
  })
  expect(models[1]!.contextWindow).toBeUndefined()
  expect(models[1]!.cost).toBeUndefined()
  expect([...publicHeaders!]).toEqual([])
  expect(await loadModels(provider, settings, storage)).toEqual(models)
})

test('호환 API의 명시적 공급자·별칭 매핑은 API 한도를 보존하고 매핑 변경 시 캐시를 갱신한다', async () => {
  const { settings: initial, storage } = await fixture((_req, res) => {
    res.end(JSON.stringify({ data: [{ id: 'alias', display_name: 'Gateway', max_input_tokens: 64000, max_tokens: 8192 }] }))
  })
  initial.openai.modelsDev = { provider: 'vendor', models: { alias: 'first', manual: 'second' } }
  initial.openai.models = ['alias', 'manual']
  const settings = llmSettingsSchema.parse(initial)
  const originalFetch = globalThis.fetch
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) !== 'https://models.dev/api.json') return originalFetch(url, init)
    return Response.json({ vendor: { models: {
      first: { limit: { context: 200000, output: 16000 }, cost: { input: 3, output: 15 } },
      second: { limit: { context: 100000, input: 90000, output: 4096 }, cost: { input: 0, output: 1 } }
    } } })
  })
  onTestFinished(() => fetch.mockRestore())
  const models = await loadModels('openai', settings, storage)
  expect(models[0]).toMatchObject({ value: 'openai/alias', label: 'Gateway', contextWindow: 64000, maxOutputTokens: 8192, cost: { input: 3, output: 15 } })
  expect(models[1]).toMatchObject({ value: 'openai/manual', contextWindow: 100000, maxInputTokens: 90000, maxOutputTokens: 4096, cost: { input: 0, output: 1 } })
  settings.openai.modelsDev!.models!.alias = 'second'
  expect((await loadModels('openai', settings, storage))[0]!.cost).toEqual({ input: 0, output: 1 })
  settings.openai.modelsDev = undefined
  expect((await loadModels('openai', settings, storage))[0]!.cost).toBeUndefined()
})

test.each(['offline', 'http', 'json'] as const)('models.dev의 %s 오류가 나도 공급자 모델 목록을 반환한다', async (failure) => {
  const { settings, storage } = await fixture((_req, res) => res.end(JSON.stringify({ data: [{ id: 'available' }] })))
  settings.openai.modelsDev = { provider: 'openai' }
  const originalFetch = globalThis.fetch
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) !== 'https://models.dev/api.json') return originalFetch(url, init)
    if (failure === 'offline') throw new TypeError('offline')
    return new Response('invalid', { status: failure === 'http' ? 503 : 200 })
  })
  onTestFinished(() => fetch.mockRestore())
  expect(await loadModels('openai', settings, storage)).toMatchObject([{ value: 'openai/available' }])
})
