import type { McpClientConfig } from './browser.js'

/** Plaintext MCP is restricted to local development endpoints. */
export function parseMcpHttpUrl(value: string): URL {
  const url = new globalThis.URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('MCP URL must use HTTP or HTTPS without embedded credentials or fragment')
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (url.protocol === 'http:' && !loopback) throw new Error('Remote MCP URLs must use HTTPS')
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
      parseMcpHttpUrl(server.url)
      if (
        server.headers !== undefined &&
        (!dictionary(server.headers) ||
          Object.entries(server.headers as Record<string, string>).some(
            ([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value)
          ))
      )
        throw new Error('Invalid MCP HTTP headers')
    } else if (server.transport === 'stdio' && allowStdio) {
      if (typeof server.command !== 'string' || !server.command.trim()) throw new Error('MCP command is required')
      if (server.args !== undefined && !strings(server.args)) throw new Error('MCP arguments must be strings')
      if (server.env !== undefined && !dictionary(server.env)) throw new Error('MCP environment values must be strings')
      if (server.cwd !== undefined && typeof server.cwd !== 'string')
        throw new Error('MCP working directory must be a string')
    } else throw new Error(allowStdio ? 'Unsupported MCP transport' : 'Web MCP connections require Streamable HTTP')
    return globalThis.structuredClone(server) as McpClientConfig
  })
}
