import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { McpCredentialStorage } from '@keundal/mcp'
import { McpClient, McpOAuth, McpAuthenticationRequiredError } from '@keundal/plugin-mcp-client'
import { McpClient as BrowserClient } from '@keundal/plugin-mcp-client/browser'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { expect, test, vi, type TestContext } from 'vitest'

import { createFixture } from './fixtures/server.ts'

async function fixture(t: TestContext, clientId: string | null = 'registered-client') {
  let origin = ''
  let access = ''
  let refresh = ''
  let grant: { code: string; challenge: string; redirect: string } | undefined
  const state = {
    expiresIn: 3600,
    refreshes: 0,
    tokenRequests: 0,
    failure: '',
    failureStatus: 400,
    issueRefresh: true,
    rejectAccess: false,
    registrations: 0,
    resourcePath: '/mcp'
  }
  const values = new Map<string, string>()
  const storage: McpCredentialStorage = {
    async load(key) {
      return values.get(key) ?? null
    },
    async save(key, value) {
      if (value === null) values.delete(key)
      else values.set(key, value)
    }
  }
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const servers = new Set<ReturnType<typeof createFixture>['server']>()
  const mcpState = createFixture({ tools: {} }).state
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin)
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        json({
          resource: `${origin}${state.resourcePath}`,
          authorization_servers: [origin],
          scopes_supported: ['issues:read']
        })
      } else if (url.pathname === '/.well-known/oauth-authorization-server') {
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true
        })
      } else if (url.pathname === '/register') {
        state.registrations++
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        json({ ...JSON.parse(Buffer.concat(chunks).toString()), client_id: 'dynamic-client' }, 201)
      } else if (url.pathname === '/authorize') {
        if (url.searchParams.get('code_challenge_method') !== 'S256') return json({}, 400)
        grant = {
          code: randomUUID(),
          challenge: url.searchParams.get('code_challenge')!,
          redirect: url.searchParams.get('redirect_uri')!
        }
        const callback = new URL(grant.redirect)
        callback.searchParams.set('code', grant.code)
        callback.searchParams.set('state', url.searchParams.get('state')!)
        callback.searchParams.set('iss', origin)
        res.writeHead(302, { location: callback.href })
        res.end()
      } else if (url.pathname === '/token') {
        state.tokenRequests++
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const params = new URLSearchParams(Buffer.concat(chunks).toString())
        if (state.failure)
          return json({ error: state.failure, error_description: 'secret-from-server' }, state.failureStatus)
        if (params.get('resource') !== `${origin}${state.resourcePath}`) return json({ error: 'invalid_target' }, 400)
        if (params.get('grant_type') === 'authorization_code') {
          const challenge = createHash('sha256')
            .update(params.get('code_verifier') ?? '')
            .digest('base64url')
          if (
            !grant ||
            params.get('code') !== grant.code ||
            params.get('redirect_uri') !== grant.redirect ||
            challenge !== grant.challenge
          )
            return json({ error: 'invalid_grant' }, 400)
          grant = undefined
        } else if (params.get('grant_type') === 'refresh_token') {
          state.refreshes++
          if (params.get('refresh_token') !== refresh) return json({ error: 'invalid_grant' }, 400)
        } else return json({ error: 'unsupported_grant_type' }, 400)
        access = randomUUID()
        refresh = randomUUID()
        state.rejectAccess = false
        json({
          access_token: access,
          ...(state.issueRefresh ? { refresh_token: refresh } : {}),
          token_type: 'Bearer',
          expires_in: state.expiresIn
        })
      } else if (url.pathname === '/mcp') {
        if (!access || req.headers.authorization !== `Bearer ${access}` || state.rejectAccess) {
          res.writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
          })
          return res.end()
        }
        const id = req.headers['mcp-session-id']
        let transport = typeof id === 'string' ? sessions.get(id) : undefined
        if (!transport) {
          transport = new WebStandardStreamableHTTPServerTransport({
            enableJsonResponse: true,
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => {
              sessions.set(id, transport!)
            }
          })
          const { server } = createFixture({ tools: {} }, mcpState)
          servers.add(server)
          await server.connect(transport)
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const response = await transport.handleRequest(
          new Request(url, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
          })
        )
        res.writeHead(response.status, Object.fromEntries(response.headers))
        if (response.body) await pipeline(Readable.fromWeb(response.body), res).catch(() => {})
        else res.end()
      } else json({}, 404)
    } catch {
      res.writeHead(500)
      res.end()
    }
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  t.onTestFinished(async () => {
    vi.restoreAllMocks()
    await Promise.all([...servers].map((server) => server.close()))
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
  const options = {
    serverUrl: `${origin}/mcp`,
    redirectUrl: `${origin}/callback`,
    storage,
    clientId: clientId ?? undefined
  }
  const account = new McpOAuth(options)
  const callback = async (account: McpOAuth) => {
    const authorization = await account.authorize()
    const response = await fetch(authorization, { redirect: 'manual' })
    expect(response.status).toBe(302)
    return response.headers.get('location')!
  }
  return {
    account,
    options,
    state,
    values,
    callback,
    mcpState,
    config: {
      serverName: 'issues',
      transport: 'streamable-http' as const,
      url: options.serverUrl,
      permissions: { tools: ['subtract'] }
    }
  }
}

test('PKCE 로그인과 저장소 복구 후 허용한 MCP 도구를 실행하고 연결을 해제한다', async (t) => {
  const f = await fixture(t)
  expect(await f.account.status()).toBe('disconnected')
  await expect(f.account.token()).rejects.toBeInstanceOf(McpAuthenticationRequiredError)
  const callback = await f.callback(f.account)
  expect(await f.account.status()).toBe('authorizing')
  // Simulate a process/redirect round-trip using the same secure storage.
  const restored = new McpOAuth(f.options)
  await restored.complete(callback)
  expect(await restored.status()).toBe('connected')
  await expect(restored.complete(callback)).rejects.toThrow('Invalid or expired')
  const client = await McpClient.connect(f.config, { authentication: restored })
  t.onTestFinished(() => client.close())
  const [tool] = await client.tools()
  const result = JSON.parse(
    await tool!.execute(
      { left: 19, right: 7 },
      { threadId: 't', runId: 'r', toolCallId: 'c', signal: new AbortController().signal }
    )
  )
  expect(result.content).toEqual([{ type: 'text', text: '{"difference":12}' }])
  expect(JSON.stringify(f.config)).not.toContain(await restored.token())
  await client.close()
  await restored.disconnect()
  expect(f.values.size).toBe(0)
  expect(await restored.status()).toBe('disconnected')
  await expect(McpClient.connect(f.config, { authentication: restored })).rejects.toThrow('MCP login is required')
})

test('만료 직전의 동시 요청은 한 번 갱신하고 회전된 refresh token을 다음 갱신에 사용한다', async (t) => {
  const f = await fixture(t)
  // A root resource indicator has no slash; URL normalization must not change it on refresh.
  f.state.resourcePath = ''
  f.state.expiresIn = 1
  await f.account.complete(await f.callback(f.account))
  f.state.expiresIn = 3600
  const tokens = await Promise.all(Array.from({ length: 8 }, () => f.account.token()))
  expect(new Set(tokens).size).toBe(1)
  expect(f.state.refreshes).toBe(1)
  await f.account.onUnauthorized()
  expect(f.state.refreshes).toBe(2)
  expect(await f.account.token()).not.toBe(tokens[0])
  const rejectedToken = await f.account.token()
  await Promise.all(Array.from({ length: 5 }, () => f.account.onUnauthorized({ rejectedToken })))
  expect(f.state.refreshes).toBe(3)
})

test('refresh token이 없으면 유효한 access token을 유지하고 만료 시 재인증을 요구한다', async (t) => {
  const f = await fixture(t)
  f.state.issueRefresh = false
  f.state.expiresIn = 10
  await f.account.complete(await f.callback(f.account))
  expect(await f.account.token()).toBeTruthy()
  expect(await f.account.status()).toBe('connected')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000)
  expect(await f.account.status()).toBe('reauthentication-required')
  await expect(f.account.token()).rejects.toBeInstanceOf(McpAuthenticationRequiredError)
  expect(f.state.refreshes).toBe(0)
})

test('연결 해제는 진행 중인 도구 요청과 이전 세션을 중단하고 새 로그인 뒤 새 연결만 허용한다', async (t) => {
  const f = await fixture(t)
  await f.account.complete(await f.callback(f.account))
  const config = { ...f.config, permissions: { tools: ['wait'] } }
  const client = await McpClient.connect(config, { authentication: f.account })
  t.onTestFinished(() => client.close())
  const [tool] = await client.tools()
  const pending = tool!.execute(
    {},
    { threadId: 't', runId: 'r', toolCallId: 'c', signal: new AbortController().signal }
  )
  const rejected = expect(pending).rejects.toThrow()
  await f.mcpState.started.promise
  await f.account.disconnect()
  await rejected
  await expect(client.tools()).rejects.toThrow('disconnected')
  await f.account.complete(await f.callback(f.account))
  expect((await McpClient.probe(f.config, { authentication: f.account })).tools.length).toBeGreaterThan(0)
})

test('브라우저 진입점의 401 응답은 갱신 후 다시 연결하며 probe에도 인증을 전달한다', async (t) => {
  const f = await fixture(t)
  await f.account.complete(await f.callback(f.account))
  f.state.rejectAccess = true
  const result = await BrowserClient.probe(f.config, { authentication: f.account })
  expect(result.tools.map((tool) => tool.name)).toContain('subtract')
  expect(f.state.refreshes).toBe(1)
})

test('state와 redirect 및 issuer 변조와 중복 매개변수를 거부하고 코드를 교환하지 않는다', async (t) => {
  const f = await fixture(t)
  const callback = await f.callback(f.account)
  for (const mutate of [
    (url: URL) => url.searchParams.set('state', 'wrong'),
    (url: URL) => {
      url.pathname = '/other'
    },
    (url: URL) => url.searchParams.append('code', 'duplicate'),
    (url: URL) => {
      url.hostname = 'localhost'
    }
  ]) {
    const bad = new URL(callback)
    mutate(bad)
    await expect(f.account.complete(bad.href)).rejects.toThrow('Invalid or expired')
    expect(f.state.tokenRequests).toBe(0)
  }
  const wrongIssuer = new URL(callback)
  wrongIssuer.searchParams.set('iss', 'https://other.example')
  await expect(f.account.complete(wrongIssuer.href)).rejects.toThrow('Could not complete')
  expect(f.state.tokenRequests).toBe(0)
  expect(await f.account.status()).toBe('reauthentication-required')
})

test('거부와 만료된 로그인은 재인증이 필요하며 새 로그인은 이전 콜백을 무효화한다', async (t) => {
  const f = await fixture(t)
  const first = await f.callback(f.account)
  const second = await f.callback(f.account)
  await expect(f.account.complete(first)).rejects.toThrow('Invalid or expired')
  const denied = new URL(second)
  denied.searchParams.delete('code')
  denied.searchParams.set('error', 'access_denied')
  await expect(f.account.complete(denied.href)).rejects.toThrow('denied')
  expect(await f.account.status()).toBe('reauthentication-required')
  const expired = await f.callback(f.account)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
  await expect(f.account.complete(expired)).rejects.toThrow('Invalid or expired')
  expect(await f.account.status()).toBe('reauthentication-required')
})

test('폐기된 refresh token은 재인증으로 전환하고 새 로그인으로 복구한다', async (t) => {
  const f = await fixture(t)
  await f.account.complete(await f.callback(f.account))
  f.state.failure = 'invalid_grant'
  await expect(f.account.onUnauthorized()).rejects.toBeInstanceOf(McpAuthenticationRequiredError)
  expect(await f.account.status()).toBe('reauthentication-required')
  await expect(f.account.token()).rejects.toBeInstanceOf(McpAuthenticationRequiredError)
  f.state.failure = ''
  await f.account.complete(await f.callback(f.account))
  expect(await f.account.status()).toBe('connected')
})

test('일시적인 갱신 오류는 refresh token을 보존하고 오류 본문을 노출하지 않는다', async (t) => {
  const f = await fixture(t)
  await f.account.complete(await f.callback(f.account))
  const previous = await f.account.token()
  f.state.failure = 'server_error'
  const warn = vi.spyOn(console, 'warn')
  await expect(f.account.onUnauthorized()).rejects.toThrow('Could not refresh MCP authorization')
  expect(await f.account.status()).toBe('connected')
  expect(await f.account.token()).toBe(previous)
  expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-from-server')
  f.state.failure = ''
  await f.account.onUnauthorized()
  expect(await f.account.token()).not.toBe(previous)
})

test('HTTP 200의 OAuth 오류도 자격 증명과 로그에 원격 오류 본문을 남기지 않는다', async (t) => {
  const f = await fixture(t)
  const callback = await f.callback(f.account)
  f.state.failure = 'invalid_grant'
  f.state.failureStatus = 200
  const warn = vi.spyOn(console, 'warn')
  await expect(f.account.complete(callback)).rejects.toThrow('Could not complete MCP authorization')
  expect(await f.account.status()).toBe('reauthentication-required')
  await expect(f.account.token()).rejects.toBeInstanceOf(McpAuthenticationRequiredError)
  expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-from-server')
  expect([...f.values.values()].join(' ')).not.toContain('secret-from-server')
})

test('동적 등록과 서버별 자격 증명 격리를 지원하고 평문 원격 OAuth는 거부한다', async (t) => {
  const f = await fixture(t, null)
  await f.account.complete(await f.callback(f.account))
  expect(f.state.registrations).toBe(1)
  const other = new McpOAuth({ ...f.options, serverUrl: `${f.options.serverUrl}/other` })
  expect(await other.status()).toBe('disconnected')
  await expect(
    McpClient.connect({ ...f.config, url: `${f.config.url}/other` }, { authentication: f.account })
  ).rejects.toThrow('different server')
  await expect(
    McpClient.connect({ ...f.config, headers: { authorization: 'Bearer static' } }, { authentication: f.account })
  ).rejects.toThrow('Authorization header')
  expect(() => new McpOAuth({ ...f.options, serverUrl: 'http://remote.example/mcp' })).toThrow('HTTPS')
  expect(() => new McpOAuth({ ...f.options, redirectUrl: 'http://remote.example/callback' })).toThrow('HTTPS')
})

test('취소된 인증 작업은 요청하지 않고 저장소 오류를 평문 저장으로 우회하지 않는다', async (t) => {
  const f = await fixture(t)
  const signal = AbortSignal.abort(new Error('cancelled'))
  await expect(f.account.authorize({ signal })).rejects.toThrow('cancelled')
  expect(await f.account.status()).toBe('disconnected')
  const unavailable = new McpOAuth({
    ...f.options,
    storage: {
      async load() {
        throw new Error('secret store unavailable')
      },
      async save() {
        throw new Error('secret store unavailable')
      }
    }
  })
  await expect(unavailable.authorize()).rejects.toThrow('secret store unavailable')
  expect(f.state.tokenRequests).toBe(0)
})
