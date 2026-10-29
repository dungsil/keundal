import {
  parseMcpHttpUrl,
  type McpAuthentication,
  type McpAuthenticationState,
  type McpCredentialStorage,
  type McpOAuthOptions,
  type McpRequestOptions
} from '@keundal/mcp'
import {
  auth,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  selectResourceURL,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens
} from '@modelcontextprotocol/client'

export type { McpOAuthOptions } from '@keundal/mcp'

interface Credentials {
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  expiresAt?: number
  discovery?: OAuthDiscoveryState
  pending?: { state: string; verifier?: string; expiresAt: number }
  reauthentication?: boolean
}

export class McpAuthenticationRequiredError extends Error {
  constructor() {
    super('MCP login is required')
    this.name = 'McpAuthenticationRequiredError'
  }
}

/** One account controller per server/user. Keep it alive while its clients are connected. */
export class McpOAuth implements McpAuthentication {
  readonly serverUrl: string
  private readonly redirectUrl: string
  private readonly clientId?: string
  private readonly scope?: string
  private readonly storage: McpCredentialStorage
  private readonly key: string
  private queue: Promise<unknown> = Promise.resolve()
  private lifetime = new globalThis.AbortController()

  get signal(): AbortSignal {
    return this.lifetime.signal
  }

  private invalidateConnections() {
    const previous = this.lifetime
    this.lifetime = new globalThis.AbortController()
    previous.abort(new McpAuthenticationRequiredError())
  }

  constructor(options: McpOAuthOptions) {
    this.serverUrl = parseMcpHttpUrl(options.serverUrl).href
    this.redirectUrl = parseMcpHttpUrl(options.redirectUrl).href
    const redirect = new globalThis.URL(this.redirectUrl)
    if (['code', 'state', 'error', 'iss'].some((key) => redirect.searchParams.has(key)))
      throw new Error('OAuth redirect URL must not contain response parameters')
    this.clientId = options.clientId
    this.scope = options.scope
    this.storage = options.storage
    this.key = `mcp:oauth:${JSON.stringify([this.serverUrl, this.redirectUrl, this.clientId ?? null, this.scope ?? null])}`
  }

  private exclusive<T>(options: McpRequestOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = globalThis.AbortSignal.timeout(30_000)
    const signal = options.signal ? globalThis.AbortSignal.any([options.signal, timeout]) : timeout
    const pending = this.queue.then(() => {
      signal.throwIfAborted()
      return run(signal)
    })
    this.queue = pending.catch(() => {})
    return pending
  }

  private async load(): Promise<Credentials> {
    const saved = await this.storage.load(this.key)
    return saved === null ? {} : JSON.parse(saved)
  }

  private save(credentials: Credentials) {
    return this.storage.save(this.key, JSON.stringify(credentials))
  }

  async status(options: McpRequestOptions = {}): Promise<McpAuthenticationState> {
    return this.exclusive(options, async () => {
      const credentials = await this.load()
      if (credentials.pending && credentials.pending.expiresAt > Date.now()) return 'authorizing'
      if (credentials.reauthentication) return 'reauthentication-required'
      if (!credentials.tokens) return 'disconnected'
      if (
        credentials.expiresAt !== undefined &&
        credentials.expiresAt <= Date.now() &&
        !credentials.tokens.refresh_token
      )
        return 'reauthentication-required'
      return 'connected'
    })
  }

  /** Called only by a user action. Open the returned URL in the system browser. */
  async authorize(options: McpRequestOptions = {}): Promise<string> {
    options.signal?.throwIfAborted()
    this.invalidateConnections()
    return this.exclusive(options, async (signal) => {
      const credentials = await this.load()
      // Reauthentication deliberately discards the old account before asking for another grant.
      delete credentials.tokens
      delete credentials.expiresAt
      delete credentials.discovery
      credentials.reauthentication = true
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
      credentials.pending = {
        state: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        expiresAt: Date.now() + 10 * 60_000
      }
      await this.save(credentials)
      let authorizationUrl: string | undefined
      const provider = this.provider(credentials, (url) => {
        authorizationUrl = parseMcpHttpUrl(url.href).href
      })
      try {
        await auth(provider, {
          serverUrl: this.serverUrl,
          scope: this.scope,
          forceReauthorization: true,
          fetchFn: this.fetch(signal)
        })
        if (!authorizationUrl || !credentials.pending?.verifier) throw new Error('Missing authorization request')
        return authorizationUrl
      } catch {
        delete credentials.pending
        await this.save(credentials)
        signal.throwIfAborted()
        throw new Error('Could not start MCP authorization')
      }
    })
  }

  /** The host must forward the complete callback URL, not just the code. State is single-use. */
  async complete(callbackUrl: string, options: McpRequestOptions = {}): Promise<void> {
    return this.exclusive(options, async (signal) => {
      const credentials = await this.load()
      const pending = credentials.pending
      const callback = new globalThis.URL(callbackUrl)
      const expected = new globalThis.URL(this.redirectUrl)
      const params = callback.searchParams
      if (
        callback.origin !== expected.origin ||
        callback.pathname !== expected.pathname ||
        callback.hash ||
        callback.username ||
        callback.password ||
        [...expected.searchParams].some(
          ([key, value]) => params.getAll(key).length !== 1 || params.get(key) !== value
        ) ||
        ['code', 'state', 'error', 'iss'].some((key) => params.getAll(key).length > 1) ||
        !pending ||
        pending.expiresAt <= Date.now() ||
        params.get('state') !== pending.state
      )
        throw new Error('Invalid or expired MCP OAuth callback')
      // Consume the callback before any network operation. A denied or failed grant also needs a new login.
      delete credentials.pending
      await this.save(credentials)
      if (params.has('error') || !params.get('code') || !pending.verifier)
        throw new Error('MCP authorization was denied or incomplete')
      const provider = this.provider(credentials)
      provider.codeVerifier = () => pending.verifier!
      try {
        const result = await auth(provider, {
          serverUrl: this.serverUrl,
          authorizationCode: params.get('code')!,
          iss: params.get('iss') ?? undefined,
          fetchFn: this.fetch(signal)
        })
        if (result !== 'AUTHORIZED') throw new Error('Authorization did not complete')
      } catch {
        delete credentials.tokens
        delete credentials.expiresAt
        credentials.reauthentication = true
        await this.save(credentials)
        signal.throwIfAborted()
        throw new Error('Could not complete MCP authorization; log in again')
      }
    })
  }

  async token(options: McpRequestOptions = {}): Promise<string> {
    return this.exclusive(options, async (signal) => {
      const credentials = await this.load()
      if (!credentials.tokens) throw new McpAuthenticationRequiredError()
      // Refresh before expiry, not after a tool has already been submitted.
      if (
        credentials.expiresAt !== undefined &&
        credentials.expiresAt <= Date.now() + (credentials.tokens.refresh_token ? 30_000 : 0)
      )
        await this.refresh(credentials, signal)
      return credentials.tokens!.access_token
    })
  }

  async onUnauthorized(options: McpRequestOptions & { readonly rejectedToken?: string } = {}): Promise<void> {
    return this.exclusive(options, async (signal) => {
      const credentials = await this.load()
      if (options.rejectedToken && credentials.tokens && credentials.tokens.access_token !== options.rejectedToken)
        return
      await this.refresh(credentials, signal)
    })
  }

  private async refresh(credentials: Credentials, signal: AbortSignal) {
    const discovery = credentials.discovery
    if (!credentials.tokens?.refresh_token || !credentials.client || !discovery) {
      delete credentials.tokens
      delete credentials.expiresAt
      credentials.reauthentication = true
      await this.save(credentials)
      this.invalidateConnections()
      throw new McpAuthenticationRequiredError()
    }
    try {
      const provider = this.provider(credentials)
      const resource = await selectResourceURL(this.serverUrl, provider, discovery.resourceMetadata)
      const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation: credentials.client,
        refreshToken: credentials.tokens.refresh_token,
        resource: resource && discovery.resourceMetadata ? discovery.resourceMetadata.resource : resource,
        fetchFn: this.fetch(signal)
      })
      await provider.saveTokens({ ...tokens, issuer: credentials.tokens.issuer })
    } catch (error) {
      signal.throwIfAborted()
      if (
        error instanceof OAuthError &&
        [OAuthErrorCode.InvalidGrant, OAuthErrorCode.InvalidClient, OAuthErrorCode.UnauthorizedClient].some(
          (code) => code === error.code
        )
      ) {
        delete credentials.tokens
        delete credentials.expiresAt
        credentials.reauthentication = true
        if (error.code !== OAuthErrorCode.InvalidGrant) delete credentials.client
        await this.save(credentials)
        this.invalidateConnections()
        throw new McpAuthenticationRequiredError()
      }
      // A transient network/server failure must not erase a usable refresh token.
      throw new Error('Could not refresh MCP authorization')
    }
  }

  /** Forget the local grant and any pending login. This does not revoke the service's own account/session. */
  async disconnect(options: McpRequestOptions = {}): Promise<void> {
    options.signal?.throwIfAborted()
    this.invalidateConnections()
    return this.exclusive(options, async () => {
      await this.storage.save(this.key, null)
    })
  }

  private provider(credentials: Credentials, redirect?: (url: URL) => void): OAuthClientProvider {
    return {
      redirectUrl: this.redirectUrl,
      clientMetadata: {
        client_name: 'Keundal',
        redirect_uris: [this.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(this.scope ? { scope: this.scope } : {})
      },
      state: () => {
        if (!redirect || !credentials.pending) throw new McpAuthenticationRequiredError()
        return credentials.pending.state
      },
      clientInformation: async (context) => {
        if (!credentials.client && this.clientId) {
          credentials.client = { client_id: this.clientId, issuer: context?.issuer }
          await this.save(credentials)
        }
        return credentials.client
      },
      saveClientInformation: async (client) => {
        credentials.client = client
        await this.save(credentials)
      },
      tokens: () => credentials.tokens,
      saveTokens: async (tokens) => {
        credentials.tokens = tokens
        credentials.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000
        credentials.reauthentication = false
        await this.save(credentials)
      },
      redirectToAuthorization: (url) => {
        if (!redirect) throw new McpAuthenticationRequiredError()
        redirect(url)
      },
      saveCodeVerifier: async (verifier) => {
        if (!redirect || !credentials.pending) throw new McpAuthenticationRequiredError()
        credentials.pending.verifier = verifier
        await this.save(credentials)
      },
      codeVerifier: () => {
        if (!credentials.pending?.verifier) throw new McpAuthenticationRequiredError()
        return credentials.pending.verifier
      },
      saveDiscoveryState: async (discovery) => {
        credentials.discovery = discovery
        await this.save(credentials)
      },
      discoveryState: () => credentials.discovery,
      invalidateCredentials: async (scope) => {
        if (scope === 'all' || scope === 'tokens') {
          delete credentials.tokens
          delete credentials.expiresAt
          credentials.reauthentication = true
        }
        if (scope === 'all' || scope === 'client') delete credentials.client
        if (scope === 'all' || scope === 'discovery') delete credentials.discovery
        if (scope === 'all' || scope === 'verifier') delete credentials.pending
        await this.save(credentials)
      }
    }
  }

  private fetch(signal: AbortSignal): typeof globalThis.fetch {
    return async (input, init) => {
      const url = parseMcpHttpUrl(String(input))
      const response = await globalThis.fetch(url, { ...init, signal, redirect: 'error' }).catch(() => {
        signal.throwIfAborted()
        throw new Error('MCP OAuth network request failed')
      })
      // OAuth metadata and token bodies are untrusted too. Never include them in public errors.
      if (!response.body) return response
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 1_048_576) throw new Error('OAuth response exceeds the byte limit')
          chunks.push(value)
        }
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      } finally {
        reader.releaseLock()
      }
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      let oauthError: unknown
      try {
        oauthError = JSON.parse(new globalThis.TextDecoder().decode(body)).error
      } catch {
        /* Not JSON. */
      }
      if (!response.ok || oauthError !== undefined) {
        // The SDK logs some OAuth failures. Do not let peer-controlled descriptions reach those logs.
        let code = 'server_error'
        if (Object.values(OAuthErrorCode).some((value) => value === oauthError)) code = oauthError as string
        return globalThis.Response.json(
          { error: code, error_description: 'MCP OAuth request failed' },
          { status: response.status }
        )
      }
      return new globalThis.Response(body, { status: response.status, headers: response.headers })
    }
  }
}
