import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createInterface } from 'node:readline'

import { parseMcpServers, type McpAuthentication, type McpClientConfig, type McpCredentialStorage } from '@keundal/mcp'
import { McpClient, McpOAuth } from '@keundal/plugin-mcp-client'

/** Only the inherited anonymous pipes carry credential values, never HTTP or the webview. */
export function createNativeBridge() {
  let sequence = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    try {
      const result = JSON.parse(line)
      if (result.kind !== 'keundal-native-result') return
      const request = pending.get(result.id)
      pending.delete(result.id)
      if (result.ok) request?.resolve(result.value)
      else request?.reject(new Error('Native MCP operation failed'))
    } catch {
      /* Ignore unrelated control messages. */
    }
  })
  input.on('close', () => {
    for (const request of pending.values()) request.reject(new Error('Native control pipe closed'))
    pending.clear()
  })
  return async function request(operation: string, key?: string, value?: string | null): Promise<unknown> {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Native MCP operation timed out'))
      }, 30_000)
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer)
          resolve(value)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        }
      })
      process.stdout.write(`${JSON.stringify({ kind: 'keundal-native-request', id, operation, key, value })}\n`)
    })
  }
}

type NativeBridge = ReturnType<typeof createNativeBridge>
type HttpConfig = Extract<McpClientConfig, { transport: 'streamable-http' }>

/** Windows Credential Manager limits each value; commit a new generation only after all chunks are durable. */
export function nativeCredentialStorage(name: string, bridge: NativeBridge): McpCredentialStorage {
  const keyFor = (key: string) =>
    createHash('sha256')
      .update(JSON.stringify([name, key]))
      .digest('hex')
  type Manifest = { generation: string; count: number }
  const chunkKeys = (key: string, manifest: Manifest | null) =>
    manifest
      ? Array.from({ length: manifest.count }, (_, index) => keyFor(`${key}:${manifest.generation}:${index}`))
      : []
  const loadManifest = async (key: string): Promise<Manifest | null> => {
    const raw = (await bridge('load', keyFor(key))) as string | null
    if (raw === null) return null
    const manifest = JSON.parse(raw) as Manifest
    if (
      !manifest ||
      !/^[a-f0-9-]{36}$/.test(manifest.generation) ||
      !Number.isSafeInteger(manifest.count) ||
      manifest.count < 0 ||
      manifest.count > 2048
    )
      throw new Error('Invalid MCP credential manifest')
    return manifest
  }
  return {
    async load(key) {
      const manifest = await loadManifest(key)
      if (manifest === null) return null
      const keys = chunkKeys(key, manifest)
      const chunks = []
      for (const key of keys) {
        const chunk = await bridge('load', key)
        if (typeof chunk !== 'string') throw new Error('Incomplete MCP credentials')
        chunks.push(chunk)
      }
      return Buffer.from(chunks.join(''), 'base64').toString('utf8')
    },
    async save(key, value) {
      const root = keyFor(key)
      const previous = chunkKeys(key, await loadManifest(key))
      if (value !== null) {
        const encoded = Buffer.from(value, 'utf8').toString('base64')
        const manifest = { generation: randomUUID(), count: Math.ceil(encoded.length / 1000) }
        if (manifest.count > 2048) throw new Error('MCP credentials exceed the native secret-store limit')
        const keys = chunkKeys(key, manifest)
        try {
          for (const [index, chunk] of keys.entries())
            await bridge('save', chunk, encoded.slice(index * 1000, (index + 1) * 1000))
          await bridge('save', root, JSON.stringify(manifest))
        } catch (error) {
          await Promise.allSettled(keys.map((key) => bridge('save', key, null)))
          throw error
        }
      } else await bridge('save', root, null)
      for (const key of previous) await bridge('save', key, null)
    }
  }
}

export async function createDesktopMcpOAuth(servers: readonly McpClientConfig[], bridge: NativeBridge) {
  const configured = servers.filter(
    (server): server is HttpConfig => server.transport === 'streamable-http' && !!server.oauth
  )
  const authentication: Record<string, McpAuthentication> = Object.create(null)
  const accounts = new Map<string, McpOAuth>()
  const pending = new Map<string, { signal: AbortSignal; abort(): void }>()
  const logins = new Set<Promise<void>>()
  // A durable port keeps redirect_uri and DCR client registrations stable across host/model restarts.
  // Never silently switch ports if another process has occupied the registered callback address.
  const savedPort = configured.length ? ((await bridge('load', 'callback-port')) as string | null) : null
  const port = savedPort === null ? 0 : Number(savedPort)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid OAuth callback port')
  let callback: ReturnType<typeof createServer> | undefined
  let redirectUrl = ''
  let callbackHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined
  let listening: Promise<void> | undefined
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      callback!.once('error', reject)
      callback!.listen(port, '127.0.0.1', () => {
        callback!.removeListener('error', reject)
        resolve()
      })
    })
  const waiters = new Map<string, { resolve(): void; reject(error: unknown): void; signal: AbortSignal }>()
  if (configured.length) {
    callback = createServer((request, response) => callbackHandler?.(request, response))
    let selectedPort = port
    if (!selectedPort) {
      await listen(0)
      const address = callback.address()
      if (!address || typeof address === 'string') throw new Error('Missing callback address')
      selectedPort = address.port
      await new Promise<void>((resolve) => callback!.close(() => resolve()))
      await bridge('save', 'callback-port', String(selectedPort))
    }
    redirectUrl = `http://127.0.0.1:${selectedPort}/oauth/callback`
    for (const server of configured) {
      const account = new McpOAuth({
        serverUrl: server.url,
        redirectUrl,
        ...server.oauth,
        storage: nativeCredentialStorage(server.serverName, bridge)
      })
      // A persisted PKCE request has no live callback waiter after a host crash/replacement.
      if ((await account.status()) === 'authorizing') await account.disconnect()
      accounts.set(server.serverName, account)
      authentication[server.serverName] = account
    }
    callbackHandler = (request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      let url: URL
      try {
        url = new URL(request.url ?? '/', redirectUrl)
      } catch {
        response.writeHead(400).end('Invalid OAuth callback')
        return
      }
      const waiter = waiters.get(url.searchParams.get('state') ?? '')
      if (
        request.method !== 'GET' ||
        request.headers.host !== new URL(redirectUrl).host ||
        url.origin !== new URL(redirectUrl).origin ||
        url.pathname !== '/oauth/callback' ||
        !waiter
      ) {
        response.writeHead(400).end('Invalid OAuth callback')
        return
      }
      waiters.delete(url.searchParams.get('state')!)
      // complete() verifies state, issuer, duplicate parameters and the entire redirect URI.
      const name = [...pending].find(([, controller]) => controller.signal === waiter.signal)?.[0]
      const account = name ? accounts.get(name) : undefined
      if (!account) {
        response.writeHead(400).end('Login is no longer active')
        return
      }
      void account.complete(url.href, { signal: waiter.signal }).then(
        () => {
          response.end('Login complete. Return to Keundal.')
          waiter.resolve()
        },
        (error) => {
          response.writeHead(400).end('Login failed. Return to Keundal and try again.')
          waiter.reject(error)
        }
      )
    }
  }

  async function connect(name: string, account: McpOAuth, signal: AbortSignal) {
    pending.get(name)?.abort()
    const controller = new AbortController()
    const lifetime = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(10 * 60_000)])
    // The map must contain the combined signal so callback lookup cannot match a superseded login.
    const active = { signal: lifetime, abort: () => controller.abort() }
    pending.set(name, active)
    try {
      // Hold the callback socket only during login, allowing atomic sidecar/model replacement.
      // The durable redirect port is never changed if it has become unavailable.
      listening ??= listen(Number(new URL(redirectUrl).port)).catch((error) => {
        listening = undefined
        throw error
      })
      await listening
      lifetime.throwIfAborted()
      const url = await account.authorize({ signal: lifetime })
      const state = new URL(url).searchParams.get('state')
      if (!state) throw new Error('Missing OAuth state')
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('MCP login cancelled'))
        lifetime.addEventListener('abort', abort, { once: true })
        const finish = (error?: unknown) => {
          lifetime.removeEventListener('abort', abort)
          waiters.delete(state)
          if (error) reject(error)
          else resolve()
        }
        waiters.set(state, { signal: lifetime, resolve: () => finish(), reject: finish })
        if (lifetime.aborted) finish(new Error('MCP login cancelled'))
        else void bridge('open', undefined, url).catch(finish)
      })
    } catch (error) {
      // serialize clearing with token/refresh writes; never clear a newer login's pending state.
      if (pending.get(name) === active) await account.disconnect()
      throw error
    } finally {
      if (pending.get(name) === active) pending.delete(name)
      for (const [state, waiter] of waiters) if (waiter.signal === lifetime) waiters.delete(state)
      if (!pending.size && callback?.listening) {
        listening = undefined
        callback.close()
      }
    }
  }

  return {
    authentication,
    async control(action: string, name: string, signal: AbortSignal, value?: unknown) {
      if (action === 'probe') {
        const [server] = parseMcpServers([value], true)
        if (!server || server.transport !== 'streamable-http') throw new Error('HTTP server required')
        const saved = configured.find((item) => item.serverName === server.serverName)
        const account =
          saved &&
          saved.url === server.url &&
          saved.oauth?.clientId === server.oauth?.clientId &&
          saved.oauth?.scope === server.oauth?.scope &&
          !!server.oauth
            ? accounts.get(server.serverName)
            : undefined
        return McpClient.probe(server, { signal, authentication: account })
      }
      const account = accounts.get(name)
      if (!account) throw new Error('OAuth is not configured for this MCP server')
      if (action === 'status') return account.status({ signal })
      if (action === 'connect') {
        const login = connect(name, account, signal)
        logins.add(login)
        try {
          return await login
        } finally {
          logins.delete(login)
        }
      }
      if (action === 'disconnect') {
        pending.get(name)?.abort()
        pending.delete(name)
        return account.disconnect({ signal })
      }
      throw new Error('Unknown MCP OAuth operation')
    },
    async dispose() {
      for (const controller of pending.values()) controller.abort()
      await Promise.allSettled(logins)
      callback?.close()
      callback?.closeAllConnections()
    }
  }
}

/** Controls never return credentials. Reuse host bearer authentication, with a strict origin allowlist. */
export function desktopMcpControl(
  oauth: Awaited<ReturnType<typeof createDesktopMcpOAuth>>,
  token: string,
  origins: readonly string[]
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url?.startsWith('/desktop/mcp/')) return false
    const origin = request.headers.origin
    if (origin && !origins.includes(origin)) {
      response.writeHead(403).end()
      return true
    }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type')
      response.setHeader('Access-Control-Max-Age', '600')
      response.writeHead(204).end()
      return true
    }
    const presented = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (!token.trim() || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      response.writeHead(403).end()
      return true
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return true
    }
    const controller = new AbortController()
    response.once('close', () => controller.abort())
    try {
      let body = ''
      for await (const chunk of request) {
        body += String(chunk)
        if (Buffer.byteLength(body) > 65536) throw new Error('Request too large')
      }
      const { serverName, value } = JSON.parse(body)
      const action = request.url.slice('/desktop/mcp/'.length)
      const result = await oauth.control(action, serverName, controller.signal, value)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(result ?? null))
    } catch {
      response.writeHead(400).end('MCP account operation failed')
    }
    return true
  }
}
