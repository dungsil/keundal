import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { expect, test, onTestFinished, vi } from 'vitest'
import { loadModels, MODEL_CACHE_TTL } from '../shared/utils/models'
import { defaultLLMSettings } from '../shared/utils/llm-settings'

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
  for (const provider of ['openai', 'anthropic', 'google'] as const) settings[provider] = { apiKey: `private-${provider}`, baseURL: `http://127.0.0.1:${address.port}/gateway` }
  return { requests, settings, storage, values }
}

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
