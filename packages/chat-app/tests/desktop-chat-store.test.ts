import type { invoke } from '@tauri-apps/api/core'
import { expect, test } from 'vitest'
import { createDesktopChatStore } from '../shared/utils/desktop-chat-store'

function createFixture() {
  const calls: { command: string, args: unknown }[] = []
  let fail = false
  let selection = { provider: 'openai', model: 'first' }
  let port = 9000
  const invokeNative: typeof invoke = async <T>(command: string, args?: Parameters<typeof invoke>[1]) => {
    calls.push({ command, args })
    if (fail) throw new Error('Could not start the local host')
    selection = (args as { selection: typeof selection | null }).selection ?? selection
    return { endpoint: `http://localhost:${++port}`, token: `token-${port}` } as T
  }
  const requests: { url: string, authorization: string | null }[] = []
  const request: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
    if (String(input).endsWith('/recover')) return Response.json([])
    return Response.json({ models: [{ id: selection.model, provider: selection.provider === 'google' ? 'gemini' : selection.provider, contextWindow: 128000, maxOutputTokens: 4096 }] })
  }
  return { calls, requests, invokeNative, request, setFail: (value: boolean) => {
    fail = value
  } }
}

test('데스크톱은 선택한 공급자·모델로 연결하고 전환 후 새 주소·토큰·모델 목록을 사용한다', async () => {
  const fixture = createFixture()
  const store = await createDesktopChatStore(fixture.invokeNative, () => [
    { value: 'google/second', label: 'Second', icon: '', contextWindow: 64000, maxOutputTokens: 2048 }
  ], 'openai/first', fixture.request)
  expect((await store.models())[0]!.value).toBe('openai/first')
  await store.selectModel('google/second')
  expect((await store.models())[0]!.value).toBe('google/second')
  expect(fixture.calls.map(call => call.args)).toEqual([
    { selection: { provider: 'openai', model: 'first', contextWindow: 128000, maxOutputTokens: 4096 }, restart: false },
    { selection: { provider: 'google', model: 'second', contextWindow: 64000, maxOutputTokens: 2048 }, restart: false }
  ])
  expect(fixture.requests.map(request => request.authorization)).toEqual(['Bearer token-9001', 'Bearer token-9002'])
  expect(fixture.requests.map(request => request.url)).toEqual(['http://localhost:9001/models', 'http://localhost:9002/models'])
  await store.selectModel('google/second')
  expect(fixture.calls).toHaveLength(2)
  await store.reloadSettings()
  expect(fixture.calls.at(-1)!.args).toMatchObject({ restart: true })
})

test('저장한 선택이 없으면 네이티브 공급자와 환경 변수의 기본 모델을 유지한다', async () => {
  const fixture = createFixture()
  const store = await createDesktopChatStore(fixture.invokeNative, () => [], undefined, fixture.request)
  expect(fixture.calls[0]!.args).toEqual({ selection: null, restart: false })
  expect(store.selectedModel).toBe('openai/first')
})

test('전환 후 journal 복구가 실패해도 선택한 모델과 새 연결을 유지한다', async () => {
  const fixture = createFixture()
  const request: typeof fetch = (url, init) => String(url).endsWith('/recover')
    ? Promise.resolve(Response.json({ error: 'recovery failed' }, { status: 503 }))
    : fixture.request(url, init)
  const store = await createDesktopChatStore(fixture.invokeNative, () => [], 'openai/first', request)
  await store.selectModel('anthropic/second')
  await expect(store.recover()).rejects.toThrow('recovery failed')
  expect(store.selectedModel).toBe('anthropic/second')
  expect((await store.models())[0]!.value).toBe('anthropic/second')
})

test('sidecar 전환 실패 시 기존 연결을 유지하고 같은 모델로 다시 시도한다', async () => {
  const fixture = createFixture()
  const store = await createDesktopChatStore(fixture.invokeNative, () => [], 'openai/first', fixture.request)
  fixture.setFail(true)
  await expect(store.selectModel('anthropic/second')).rejects.toThrow('Could not start')
  expect((await store.models())[0]!.value).toBe('openai/first')
  fixture.setFail(false)
  await store.selectModel('anthropic/second')
  expect((await store.models())[0]!.value).toBe('anthropic/second')
})

test('공급자 전환과 설정 재적용을 직렬화하고 마지막 선택을 유지한다', async () => {
  const fixture = createFixture()
  const store = await createDesktopChatStore(fixture.invokeNative, () => [], 'openai/shared', fixture.request)
  await Promise.all([store.selectModel('anthropic/shared'), store.reloadSettings()])
  expect(store.selectedModel).toBe('anthropic/shared')
  expect(fixture.calls.slice(1).map(call => call.args)).toEqual([
    { selection: { provider: 'anthropic', model: 'shared', contextWindow: 128000, maxOutputTokens: 4096 }, restart: false },
    { selection: { provider: 'anthropic', model: 'shared', contextWindow: 128000, maxOutputTokens: 4096 }, restart: true }
  ])
})

test('이전 연결의 journal 복구가 끝난 뒤 전환하고 새 연결도 다음 응답 전에 복구한다', async () => {
  const fixture = createFixture()
  let release!: () => void
  let recoveries = 0
  const recovery = new Promise<void>((resolve) => {
    release = resolve
  })
  const request: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/recover') && ++recoveries === 1) await recovery
    return fixture.request(url, init)
  }
  const store = await createDesktopChatStore(fixture.invokeNative, () => [], 'openai/first', request)
  const recovering = store.recover()
  const switching = store.selectModel('anthropic/second')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(fixture.calls).toHaveLength(1)
  release()
  await Promise.all([recovering, switching])
  await expect((async () => {
    for await (const _event of store.respond('missing', { model: 'anthropic/second', messages: [] })) { /* Drain. */ }
  })()).rejects.toThrow('Chat not found')
  expect(fixture.requests.filter(request => request.url.endsWith('/recover')).map(request => request.url)).toEqual([
    'http://localhost:9001/recover', 'http://localhost:9002/recover'
  ])
})

test('같은 종류와 모델의 공급자 전환에도 설정 식별자를 전달하고 재적용 시 유지한다', async () => {
  const fixture = createFixture()
  const store = await createDesktopChatStore(fixture.invokeNative, () => [], 'openai@work/shared', fixture.request)
  await store.selectModel('openai@home/shared')
  await store.reloadSettings()
  expect(store.selectedModel).toBe('openai@home/shared')
  expect(fixture.calls.map(call => call.args)).toEqual([
    { selection: { provider: 'openai', configuration: 'openai@work', model: 'shared', contextWindow: 128000, maxOutputTokens: 4096 }, restart: false },
    { selection: { provider: 'openai', configuration: 'openai@home', model: 'shared', contextWindow: 128000, maxOutputTokens: 4096 }, restart: false },
    { selection: { provider: 'openai', configuration: 'openai@home', model: 'shared', contextWindow: 128000, maxOutputTokens: 4096 }, restart: true }
  ])
})

test('제목 생성 중 모델을 바꾸면 제목 요청을 취소하고 교착 없이 새 모델로 전환한다', async () => {
  const fixture = createFixture()
  const message = { id: 'user', role: 'user' as const, parts: [{ type: 'text' as const, text: '질문' }] }
  let snapshot = { revision: 1, state: { web: { id: 'chat', title: null, messages: [message], model: 'openai/first' } } }
  let started!: () => void
  const titleStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const request: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/threads/chat')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        snapshot = { revision: snapshot.revision + 1, state: body.state }
      }
      return Response.json(snapshot)
    }
    if (String(url).endsWith('/title')) {
      started()
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      })
    }
    return fixture.request(url, init)
  }
  const store = await createDesktopChatStore(fixture.invokeNative, () => [], 'openai/first', request)
  const response = store.respond('chat', {
    model: 'openai/first', titleModel: 'anthropic/title', messages: [message]
  }).next().catch(error => error)
  await titleStarted
  await store.selectModel('google/third')
  expect(await response).toBeInstanceOf(Error)
  expect(store.selectedModel).toBe('google/third')
  expect(fixture.calls.map(call => call.args)).toMatchObject([
    { selection: { provider: 'openai', model: 'first' } },
    { selection: { provider: 'anthropic', model: 'title' } },
    { selection: { provider: 'openai', model: 'first' } },
    { selection: { provider: 'google', model: 'third' } }
  ])
})

test('같은 종류의 다른 공급자로 제목을 생성하다 취소하면 원래 공급자를 거쳐 새 공급자로 전환한다', async () => {
  const fixture = createFixture()
  const message = { id: 'user', role: 'user' as const, parts: [{ type: 'text' as const, text: '질문' }] }
  let snapshot = { revision: 1, state: { web: { id: 'chat', title: null, messages: [message], model: 'openai@chat/first' } } }
  let started!: () => void
  const titleStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const request: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/threads/chat')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        snapshot = { revision: snapshot.revision + 1, state: body.state }
      }
      return Response.json(snapshot)
    }
    if (String(url).endsWith('/title')) {
      started()
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      })
    }
    return fixture.request(url, init)
  }
  const store = await createDesktopChatStore(fixture.invokeNative, () => [], 'openai@chat/first', request)
  const response = store.respond('chat', {
    model: 'openai@chat/first', titleModel: 'openai@title/title', messages: [message]
  }).next().catch(error => error)
  await titleStarted
  await store.selectModel('openai@next/third')
  expect(await response).toBeInstanceOf(Error)
  expect(store.selectedModel).toBe('openai@next/third')
  expect(fixture.calls.map(call => call.args)).toMatchObject([
    { selection: { provider: 'openai', configuration: 'openai@chat', model: 'first' } },
    { selection: { provider: 'openai', configuration: 'openai@title', model: 'title' } },
    { selection: { provider: 'openai', configuration: 'openai@chat', model: 'first' } },
    { selection: { provider: 'openai', configuration: 'openai@next', model: 'third' } }
  ])
})
