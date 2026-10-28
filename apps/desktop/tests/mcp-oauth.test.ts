import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { NativeInvoke } from '@keundal/chat/platform'
import { createNativeMcpOAuth } from '@keundal/plugin-chat-desktop/mcp'
import { expect, test, type TestContext } from 'vitest'

import { createDesktopMcpOAuth, desktopMcpControl, nativeCredentialStorage } from '../sidecar/mcp-oauth.js'

function secrets() {
  const values = new Map<string, string>()
  return {
    values,
    async bridge(operation: string, key?: string, value?: string | null): Promise<unknown> {
      if (operation === 'load') return values.get(key!) ?? null
      if (operation === 'save') {
        if (value === null) values.delete(key!)
        else {
          expect(Buffer.byteLength(value!)).toBeLessThan(2400)
          values.set(key!, value!)
        }
        return null
      }
      throw new Error('Unexpected native operation')
    }
  }
}

async function listen(server: ReturnType<typeof createServer>, t: TestContext) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

test('큰 Unicode 자격 증명과 회전된 토큰은 작은 OS 항목으로 확정하고 이전 세대를 삭제한다', async () => {
  const native = secrets()
  const storage = nativeCredentialStorage('work', native.bridge)
  const initial = JSON.stringify({ refresh_token: 'old', metadata: '한글🎉'.repeat(2000) })
  await storage.save('account', initial)
  expect(await storage.load('account')).toBe(initial)
  const firstKeys = [...native.values.keys()]
  const restored = nativeCredentialStorage('work', native.bridge)
  await restored.save('account', JSON.stringify({ refresh_token: 'rotated' }))
  expect(await storage.load('account')).toBe(JSON.stringify({ refresh_token: 'rotated' }))
  expect(firstKeys.filter((key) => native.values.has(key))).toHaveLength(1)
  expect(await nativeCredentialStorage('other', native.bridge).load('account')).toBeNull()
  await restored.save('account', null)
  expect(native.values.size).toBe(0)
})

test('새 자격 증명의 일부 OS 쓰기가 실패하면 이전 확정된 토큰을 보존한다', async () => {
  const native = secrets()
  const storage = nativeCredentialStorage('work', native.bridge)
  await storage.save('account', 'previous')
  let writes = 0
  const failing = nativeCredentialStorage('work', async (operation, key, value) => {
    if (operation === 'save' && value !== null && ++writes === 2) throw new Error('OS denied write')
    return native.bridge(operation, key, value)
  })
  await expect(failing.save('account', 'next'.repeat(1000))).rejects.toThrow('OS denied write')
  expect(await storage.load('account')).toBe('previous')
  expect(native.values.size).toBe(2)
})

async function authorizationServer(t: TestContext) {
  let origin = ''
  let refreshes = 0
  let refresh = 'initial-refresh'
  const requests: URLSearchParams[] = []
  const authorizationHeaders: string[] = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin)
    const json = (value: unknown) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(value))
    }
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      })
    if (url.pathname === '/token') {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const params = new URLSearchParams(body)
      requests.push(params)
      if (params.get('grant_type') === 'refresh_token') {
        expect(params.get('refresh_token')).toBe(refresh)
        refresh = `rotated-${++refreshes}`
      }
      return json({
        access_token: `access-${refreshes}`,
        refresh_token: refresh,
        expires_in: 3600,
        token_type: 'Bearer'
      })
    }
    if (url.pathname === '/mcp') {
      authorizationHeaders.push(request.headers.authorization ?? '')
      if (request.headers.authorization !== `Bearer access-${refreshes}`) {
        response.writeHead(401).end()
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const message = JSON.parse(body)
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'secured', version: '1' }
            }
          : { tools: [{ name: 'secured_tool', inputSchema: { type: 'object' } }] }
      return json({ jsonrpc: '2.0', id: message.id, result })
    }
    response.writeHead(404).end()
  })
  origin = await listen(server, t)
  return { origin, requests, authorizationHeaders }
}

test('시스템 브라우저의 전체 callback 후에만 연결을 완료하고 재시작 뒤 갱신 토큰을 복원한다', async (t) => {
  const issuer = await authorizationServer(t)
  const native = secrets()
  const urls: URL[] = []
  let callbackResponse: Promise<Response> | undefined
  const bridge = async (operation: string, key?: string, value?: string | null) => {
    if (operation !== 'open') return native.bridge(operation, key, value)
    const url = new URL(value!)
    urls.push(url)
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'user-grant')
    callback.searchParams.set('state', 'wrong-state')
    expect((await fetch(callback)).status).toBe(400)
    callback.searchParams.set('state', url.searchParams.get('state')!)
    callbackResponse = fetch(callback)
    return null
  }
  const servers = [
    {
      serverName: 'work',
      transport: 'streamable-http' as const,
      url: `${issuer.origin}/mcp`,
      oauth: { clientId: 'public-client' }
    }
  ]
  const host = await createDesktopMcpOAuth(servers, bridge)
  t.onTestFinished(() => host.dispose())
  const signal = new AbortController().signal
  const oldLifetime = host.authentication.work!.signal
  await host.control('connect', 'work', signal)
  expect((await callbackResponse)?.status).toBe(200)
  expect(oldLifetime.aborted).toBe(true)
  expect(await host.control('status', 'work', signal)).toBe('connected')
  const verifier = issuer.requests[0]!.get('code_verifier')!
  expect(createHash('sha256').update(verifier).digest('base64url')).toBe(urls[0]!.searchParams.get('code_challenge'))
  expect(await host.control('probe', '', signal, servers[0])).toMatchObject({ tools: [{ name: 'secured_tool' }] })
  expect(issuer.authorizationHeaders.length).toBeGreaterThan(0)
  expect(issuer.authorizationHeaders.every((value) => value === 'Bearer access-0')).toBe(true)
  await host.authentication.work!.onUnauthorized()
  expect(await host.authentication.work!.token()).toBe('access-1')
  const redirect = urls[0]!.searchParams.get('redirect_uri')
  await host.dispose()
  const restored = await createDesktopMcpOAuth(servers, bridge)
  t.onTestFinished(() => restored.dispose())
  expect(await restored.control('status', 'work', signal)).toBe('connected')
  await restored.authentication.work!.onUnauthorized()
  expect(await restored.authentication.work!.token()).toBe('access-2')
  await restored.control('connect', 'work', signal)
  expect(urls[1]!.searchParams.get('redirect_uri')).toBe(redirect)
  const activeLifetime = restored.authentication.work!.signal
  await restored.control('disconnect', 'work', signal)
  expect(activeLifetime.aborted).toBe(true)
  expect(await restored.control('status', 'work', signal)).toBe('disconnected')
  expect(native.values.size).toBe(1) // Only the non-secret stable callback port remains.
})

test('진행 중 로그인은 disconnect가 취소하고 callback 대기와 저장된 PKCE 상태를 제거한다', async (t) => {
  const issuer = await authorizationServer(t)
  const native = secrets()
  let opened: URL | undefined
  const host = await createDesktopMcpOAuth(
    [{ serverName: 'work', transport: 'streamable-http', url: `${issuer.origin}/mcp`, oauth: { clientId: 'public' } }],
    async (operation, key, value) => {
      if (operation === 'open') {
        opened = new URL(value!)
        return null
      }
      return native.bridge(operation, key, value)
    }
  )
  t.onTestFinished(() => host.dispose())
  const signal = new AbortController().signal
  const login = host.control('connect', 'work', signal)
  const failure = expect(login).rejects.toThrow('cancelled')
  await expect.poll(() => opened).toBeDefined()
  expect(await host.control('status', 'work', signal)).toBe('authorizing')
  await host.control('disconnect', 'work', signal)
  await failure
  expect(await host.control('status', 'work', signal)).toBe('disconnected')
  expect(native.values.size).toBe(1)
})

test('네이티브 계정 제어는 Bearer와 허용 Origin을 검사하고 renderer에는 상태만 돌려준다', async (t) => {
  const host = await createDesktopMcpOAuth([], secrets().bridge)
  const control = desktopMcpControl(host, 'host-token', ['http://tauri.localhost'])
  const server = createServer((request, response) => {
    void control(request, response)
  })
  const endpoint = await listen(server, t)
  const preflight = await fetch(`${endpoint}/desktop/mcp/connect`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://tauri.localhost',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type'
    }
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost')
  expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
  expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization,content-type')
  expect(
    (await fetch(`${endpoint}/desktop/mcp/connect`, { method: 'OPTIONS', headers: { origin: 'https://evil.test' } }))
      .status
  ).toBe(403)
  for (const headers of [
    {},
    { authorization: 'Bearer wrong' },
    { authorization: 'Bearer host-token', origin: 'https://evil.test' }
  ]) {
    expect((await fetch(`${endpoint}/desktop/mcp/status`, { method: 'POST', headers, body: '{}' })).status).toBe(403)
  }
  const invoke: NativeInvoke = async <T>(command: string) => {
    expect(command).toBe('sidecar_current_info')
    return { endpoint, token: 'host-token' } as T
  }
  const oauth = createNativeMcpOAuth(invoke)
  await expect(oauth.status('unknown')).rejects.toThrow('MCP account operation failed')
  const controller = new AbortController()
  controller.abort()
  await expect(oauth.connect('work', { signal: controller.signal })).rejects.toThrow()
})

test('번들 sidecar는 전용 pipe로 자격 증명을 저장하고 호스트 도구 카탈로그와 연결 검사에 OAuth를 주입한다', async (t) => {
  const issuer = await authorizationServer(t)
  const native = secrets()
  const directory = mkdtempSync(join(tmpdir(), 'keundal-oauth-'))
  const config = {
    serverName: 'work',
    transport: 'streamable-http',
    url: `${issuer.origin}/mcp`,
    oauth: { clientId: 'public' },
    permissions: { tools: '*' }
  }
  const bridgeErrors: unknown[] = []
  const start = async () => {
    const child = spawn(process.execPath, ['dist-sidecar/main.js'], {
      env: {
        KEUNDAL_SIDECAR: '1',
        KEUNDAL_SHUTDOWN_ON_STDIN: '1',
        KEUNDAL_API_TOKEN: 'host-token',
        KEUNDAL_PROVIDER: 'openai',
        KEUNDAL_MODEL: 'test',
        KEUNDAL_BASE_URL: 'http://127.0.0.1:1',
        KEUNDAL_SQLITE_PATH: join(directory, 'test.sqlite'),
        KEUNDAL_MCP_SERVERS: JSON.stringify([config]),
        KEUNDAL_CORS_ORIGINS: 'http://tauri.localhost'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let endpoint = ''
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.startsWith('{')) return
      const message = JSON.parse(line)
      if (message.kind === 'keundal-sidecar') {
        endpoint = message.url
        return
      }
      if (message.kind !== 'keundal-native-request') return
      void (async () => {
        let value: unknown = null
        if (message.operation === 'open') {
          const authorization = new URL(message.value)
          const callback = new URL(authorization.searchParams.get('redirect_uri')!)
          callback.searchParams.set('code', 'user-grant')
          callback.searchParams.set('state', authorization.searchParams.get('state')!)
          expect((await fetch(callback)).status).toBe(200)
        } else value = await native.bridge(message.operation, message.key, message.value)
        child.stdin.write(`${JSON.stringify({ kind: 'keundal-native-result', id: message.id, ok: true, value })}\n`)
      })().catch((error) => bridgeErrors.push(error))
    })
    t.onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        await exited
      }
    })
    await expect.poll(() => endpoint, { timeout: 10000 }).not.toBe('')
    return { child, endpoint }
  }
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  let current = await start()
  const invoke: NativeInvoke = async <T>(_command: string, args?: Record<string, unknown>) => {
    if (args?.restart) {
      const previous = current
      current = await start()
      const exited = once(previous.child, 'exit')
      previous.child.kill('SIGTERM')
      await exited
    }
    return { endpoint: current.endpoint, token: 'host-token' } as T
  }
  const oauth = createNativeMcpOAuth(invoke)
  await oauth.connect('work')
  expect(await oauth.status('work')).toBe('connected')
  expect(await oauth.probe(config)).toMatchObject({ tools: [{ name: 'secured_tool' }] })
  const catalog = await fetch(`${current.endpoint}/catalog`, { headers: { authorization: 'Bearer host-token' } })
  expect(catalog.status).toBe(200)
  expect(await catalog.text()).toContain('secured_tool')
  const preflight = await fetch(`${current.endpoint}/desktop/mcp/status`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://tauri.localhost',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type'
    }
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost')
  await oauth.disconnect('work')
  expect(await oauth.status('work')).toBe('disconnected')
  await expect(oauth.probe(config)).rejects.toThrow('MCP account operation failed')
  await oauth.connect('work')
  const nextCatalog = await fetch(`${current.endpoint}/catalog`, { headers: { authorization: 'Bearer host-token' } })
  expect(nextCatalog.status).toBe(200)
  expect(await nextCatalog.text()).toContain('secured_tool')
  expect(bridgeErrors).toEqual([])
}, 15000)
