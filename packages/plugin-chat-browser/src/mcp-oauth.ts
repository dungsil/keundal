import {
  parseMcpHttpUrl,
  type McpAuthentication,
  type McpAuthenticationState,
  type McpClientConfig,
  type McpOAuthAccount,
  type McpOAuthManager,
  type McpOAuthOptions,
  type McpRequestOptions
} from '@keundal/mcp'

/** Browser grants live only in this app instance, never in Web Storage or IndexedDB. */
export class BrowserMcpOAuth implements McpOAuthManager {
  private readonly credentials = new Map<string, string>()
  private readonly accounts = new Map<string, Promise<McpOAuthAccount>>()
  private readonly pending = new Map<string, AbortController>()

  constructor(
    private readonly configuration: () => McpClientConfig[],
    private readonly changed: () => Promise<void>,
    private readonly createAccount: (options: McpOAuthOptions) => Promise<McpOAuthAccount>
  ) {}

  private account(server: McpClientConfig): Promise<McpOAuthAccount> {
    if (server.transport !== 'streamable-http' || !server.oauth) throw new Error('OAuth is not configured')
    const redirectUrl = new URL('/mcp/oauth-callback.html', window.location.origin).href
    const key = JSON.stringify([
      parseMcpHttpUrl(server.url).href,
      server.oauth.clientId,
      server.oauth.scope,
      redirectUrl
    ])
    let account = this.accounts.get(key)
    if (!account) {
      account = this.createAccount({
        serverUrl: server.url,
        redirectUrl,
        ...server.oauth,
        storage: {
          load: async (key) => this.credentials.get(key) ?? null,
          save: async (key, value) => {
            if (value === null) this.credentials.delete(key)
            else this.credentials.set(key, value)
          }
        }
      })
      this.accounts.set(key, account)
    }
    return account
  }

  private server(name: string) {
    const server = this.configuration().find((server) => server.serverName === name)
    if (!server) throw new Error('Unknown MCP server')
    return server
  }

  async authentication(server: McpClientConfig): Promise<McpAuthentication | undefined> {
    return server.transport === 'streamable-http' && server.oauth ? this.account(server) : undefined
  }

  async status(name: string, options?: McpRequestOptions): Promise<McpAuthenticationState> {
    return (await this.account(this.server(name))).status(options)
  }

  async connect(name: string, options: McpRequestOptions = {}): Promise<void> {
    options.signal?.throwIfAborted()
    const server = this.server(name)
    if (this.pending.has(name)) throw new Error('MCP login is already in progress')
    // Open synchronously in the click handler, before SDK discovery or stopping active responses.
    const popup = window.open('about:blank', '_blank', 'popup,width=600,height=760')
    if (!popup) throw new Error('Allow popups to log in to MCP')
    popup.opener = null
    const controller = new AbortController()
    this.pending.set(name, controller)
    const closed = setInterval(() => {
      if (popup.closed) controller.abort(new Error('MCP login was cancelled'))
    }, 200)
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(10 * 60_000),
      ...(options.signal ? [options.signal] : [])
    ])
    let account: McpOAuthAccount | undefined
    try {
      account = await this.account(server)
      await this.changed()
      const url = await account.authorize({ signal })
      signal.throwIfAborted()
      if (popup.closed) throw new Error('MCP login was cancelled')
      popup.location.href = url
      const callback = await new Promise<string>((resolve, reject) => {
        const abort = () => finish(signal.reason)
        const finish = (error?: unknown, callback?: string) => {
          clearInterval(timer)
          signal.removeEventListener('abort', abort)
          if (error) reject(error)
          else resolve(callback!)
        }
        const timer = setInterval(() => {
          try {
            const callback = new URL(popup.location.href)
            if (callback.origin === window.location.origin && callback.pathname === '/mcp/oauth-callback.html')
              finish(undefined, callback.href)
          } catch {
            /* The authorization page is cross-origin until it returns. */
          }
        }, 200)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      await account.complete(callback, { signal })
      signal.throwIfAborted()
      // A configuration changed while the popup was open must not inherit this grant.
      if (JSON.stringify(this.server(name)) !== JSON.stringify(server))
        throw new Error('MCP settings changed during login')
    } catch (error) {
      await account?.disconnect()
      throw error
    } finally {
      clearInterval(closed)
      this.pending.delete(name)
      popup.close()
      await this.changed()
    }
  }

  async disconnect(name: string, options?: McpRequestOptions): Promise<void> {
    this.pending.get(name)?.abort(new Error('MCP account disconnected'))
    await (await this.account(this.server(name))).disconnect(options)
    await this.changed()
  }
}
