import type { ExecutableTool } from '@keundal/tools'

export interface McpPermissions {
  readonly tools?: '*' | readonly string[]
  readonly resources?: '*' | readonly string[]
}

export type McpClientConfig = {
  readonly serverName: string
  readonly permissions?: McpPermissions
  readonly timeoutMs?: number
  readonly maxResultBytes?: number
} & (
  | {
      readonly transport: 'stdio'
      readonly command: string
      readonly args?: string[]
      readonly env?: Record<string, string>
      readonly cwd?: string
    }
  | {
      readonly transport: 'streamable-http'
      readonly url: string
      readonly headers?: Record<string, string>
      readonly oauth?: { readonly clientId?: string; readonly scope?: string }
      readonly redirect?: 'error'
      readonly allowInsecureHttp?: boolean
    }
)

export interface McpRequestOptions {
  readonly signal?: AbortSignal
}

/** Credentials stay outside serializable server settings and are scoped to one resource. */
export interface McpAuthentication {
  readonly serverUrl: string
  /** Aborts existing transports when the account changes or is disconnected. */
  readonly signal: AbortSignal
  token(options?: McpRequestOptions): Promise<string>
  onUnauthorized(options?: McpRequestOptions & { readonly rejectedToken?: string }): Promise<void>
}

export interface McpConnectOptions extends McpRequestOptions {
  readonly authentication?: McpAuthentication
}

/** Consumers own connection lifetimes; the application selects the transport implementation. */
export interface McpConnection {
  tools(options?: McpRequestOptions): Promise<ExecutableTool[]>
  close(): Promise<void>
}

export interface McpConnector {
  connect(config: McpClientConfig, options?: McpConnectOptions): Promise<McpConnection>
  probe(config: McpClientConfig, options?: McpConnectOptions): Promise<McpProbeResult>
}

/** Implement with an OS secret store or an access-controlled server-side secret store. Never localStorage. */
export interface McpCredentialStorage {
  load(key: string): Promise<string | null>
  save(key: string, credentials: string | null): Promise<void>
}

export type McpAuthenticationState = 'disconnected' | 'authorizing' | 'connected' | 'reauthentication-required'

export interface McpOAuthOptions {
  readonly serverUrl: string
  readonly redirectUrl: string
  readonly clientId?: string
  readonly scope?: string
  /** Must be isolated by application user/account on a shared server. */
  readonly storage: McpCredentialStorage
}

export interface McpOAuthAccount extends McpAuthentication {
  status(options?: McpRequestOptions): Promise<McpAuthenticationState>
  authorize(options?: McpRequestOptions): Promise<string>
  complete(callbackUrl: string, options?: McpRequestOptions): Promise<void>
  disconnect(options?: McpRequestOptions): Promise<void>
}

/** Account actions never expose tokens to the settings UI. */
export interface McpOAuthManager {
  status(serverName: string, options?: McpRequestOptions): Promise<McpAuthenticationState>
  connect(serverName: string, options?: McpRequestOptions): Promise<void>
  disconnect(serverName: string, options?: McpRequestOptions): Promise<void>
}

/** A tool the server reports; listing it never grants permission to run it. */
export interface McpToolSummary {
  readonly name: string
  readonly description?: string
}

/** What a connection check learned from the server without executing any tool. */
export interface McpProbeResult {
  readonly tools: readonly McpToolSummary[]
  readonly resources: { readonly supported: boolean; readonly count: number }
}

export interface McpSettingsStorage {
  load(): Promise<string | null>
  save(settings: string | null): Promise<void>
}

/** Remote plaintext MCP requires an explicit per-server opt-in. */
export function parseMcpHttpUrl(value: string, allowInsecureHttp?: boolean): URL {
  if (allowInsecureHttp !== undefined && typeof allowInsecureHttp !== 'boolean')
    throw new Error('MCP allowInsecureHttp must be a boolean')
  const url = new globalThis.URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('MCP URL must use HTTP or HTTPS without embedded credentials or fragment')
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (url.protocol === 'http:' && !loopback && allowInsecureHttp !== true)
    throw new Error('Remote MCP URLs must use HTTPS')
  return url
}

/** Validate persisted configuration before opening connections or starting processes. */
export function parseMcpServers(value: unknown, allowStdio = true): McpClientConfig[] {
  if (!Array.isArray(value)) throw new Error('MCP servers must be an array')
  const names = new Set<string>()
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  const dictionary = (value: unknown) => record(value) && Object.values(value).every((item) => typeof item === 'string')
  return value.map((server) => {
    if (!record(server) || typeof server.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(server.serverName))
      throw new Error('Each MCP server needs a name with 1–32 letters, digits, underscores or hyphens')
    if (names.has(server.serverName)) throw new Error(`Duplicate MCP server name: ${server.serverName}`)
    names.add(server.serverName)
    if (
      server.timeoutMs !== undefined &&
      (!Number.isSafeInteger(server.timeoutMs) || (server.timeoutMs as number) <= 0)
    )
      throw new Error('MCP timeout must be a positive integer')
    if (
      server.maxResultBytes !== undefined &&
      (!Number.isSafeInteger(server.maxResultBytes) || (server.maxResultBytes as number) <= 0)
    )
      throw new Error('MCP maxResultBytes must be a positive integer')
    if (server.permissions !== undefined) {
      if (
        !record(server.permissions) ||
        Object.entries(server.permissions).some(
          ([key, scope]) => !['tools', 'resources'].includes(key) || (scope !== '*' && !strings(scope))
        )
      )
        throw new Error('MCP permissions must be "*" or arrays of names')
    }
    if (server.transport === 'streamable-http') {
      if (typeof server.url !== 'string') throw new Error('MCP HTTP URL is required')
      parseMcpHttpUrl(server.url, server.allowInsecureHttp as boolean | undefined)
      if (server.oauth !== undefined) {
        if (
          !record(server.oauth) ||
          Object.entries(server.oauth).some(
            ([key, value]) => !['clientId', 'scope'].includes(key) || typeof value !== 'string' || !value.trim()
          )
        )
          throw new Error('MCP OAuth requires a client ID and scope as nonempty strings when provided')
        parseMcpHttpUrl(server.url)
        if (record(server.headers) && Object.keys(server.headers).some((key) => key.toLowerCase() === 'authorization'))
          throw new Error('MCP OAuth cannot be combined with an Authorization header')
      }
      if (
        server.headers !== undefined &&
        (!dictionary(server.headers) ||
          Object.entries(server.headers as Record<string, string>).some(
            ([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value)
          ))
      )
        throw new Error('Invalid MCP HTTP headers')
    } else if (server.transport === 'stdio' && allowStdio) {
      if (server.oauth !== undefined) throw new Error('MCP OAuth requires Streamable HTTP')
      if (typeof server.command !== 'string' || !server.command.trim()) throw new Error('MCP command is required')
      if (server.args !== undefined && !strings(server.args)) throw new Error('MCP arguments must be strings')
      if (server.env !== undefined && !dictionary(server.env)) throw new Error('MCP environment values must be strings')
      if (server.cwd !== undefined && typeof server.cwd !== 'string')
        throw new Error('MCP working directory must be a string')
    } else throw new Error(allowStdio ? 'Unsupported MCP transport' : 'Web MCP connections require Streamable HTTP')
    return globalThis.structuredClone(server) as McpClientConfig
  })
}
