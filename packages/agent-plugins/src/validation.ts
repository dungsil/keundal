import { validateHeaderName, validateHeaderValue } from 'node:http'
import process from 'node:process'

export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
export interface PluginManifest {
  readonly $schema: typeof PLUGIN_SCHEMA
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly author?: { readonly name?: string; readonly email?: string; readonly url?: string }
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords?: readonly string[]
}
export interface PluginDiagnostic {
  readonly component: 'manifest' | 'skills' | 'mcp'
  readonly entry?: string
  readonly message: string
}
export type Report = (component: PluginDiagnostic['component'], message: string, entry?: string) => void
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function strings(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every((v) => typeof v === 'string')
}
function only(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('unknown configuration field')
}
export function manifest(value: unknown, report: Report): PluginManifest {
  if (!object(value)) throw new Error('plugin.json must be an object')
  if (value.$schema !== PLUGIN_SCHEMA) throw new Error('unsupported plugin $schema')
  if (
    typeof value.name !== 'string' ||
    value.name.length > 64 ||
    !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.name)
  ) {
    throw new Error('invalid plugin name')
  }
  const known = [
    '$schema',
    'name',
    'version',
    'description',
    'author',
    'homepage',
    'repository',
    'license',
    'keywords',
    'extensions'
  ]
  for (const key of Object.keys(value)) if (!known.includes(key)) report('manifest', 'unknown field ignored', key)
  for (const key of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (key in value && typeof value[key] !== 'string') throw new Error(`invalid manifest ${key}`)
  }
  if ('author' in value) {
    if (!strings(value.author)) throw new Error('invalid manifest author')
    only(value.author, ['name', 'email', 'url'])
  }
  if ('keywords' in value && (!Array.isArray(value.keywords) || !value.keywords.every((v) => typeof v === 'string'))) {
    throw new Error('invalid manifest keywords')
  }
  if ('extensions' in value && !object(value.extensions)) report('manifest', 'non-object extensions ignored')
  // No client extensions are implemented. Their values must not be validated.
  return Object.freeze(
    Object.fromEntries(Object.entries(value).filter(([key]) => known.includes(key) && key !== 'extensions'))
  ) as unknown as PluginManifest
}
export type Server =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'streamable-http' | 'sse'; url: string; headers?: Record<string, string> }
export function server(value: unknown): Server {
  if (!object(value)) throw new Error('server must be an object')
  if (value.type === 'stdio') {
    only(value, ['type', 'command', 'args', 'env', 'cwd'])
    if (typeof value.command !== 'string' || !value.command || value.command.includes('\0'))
      throw new Error('invalid command')
    if (!value.command.startsWith('./') && !/^[^\s/\\:;$`|&<>"'{}]+$/.test(value.command))
      throw new Error('command must be a bare executable or ./ path')
    if ('args' in value && (!Array.isArray(value.args) || !value.args.every((v) => typeof v === 'string')))
      throw new Error('invalid args')
    if ('env' in value) {
      if (!strings(value.env)) throw new Error('invalid env')
      if (
        Object.keys(value.env).some((key) =>
          ['PLUGIN_ROOT', 'PLUGIN_DATA'].includes(process.platform === 'win32' ? key.toUpperCase() : key)
        )
      )
        throw new Error('reserved plugin environment variable')
    }
    if (
      'cwd' in value &&
      (typeof value.cwd !== 'string' || !/^(\.\/|\$\{PLUGIN_ROOT\}(\/|$)|\$\{PLUGIN_DATA\}(\/|$))/.test(value.cwd))
    )
      throw new Error('invalid cwd')
  } else if (value.type === 'streamable-http' || value.type === 'sse') {
    only(value, ['type', 'url', 'headers'])
    if (typeof value.url !== 'string' || !/^https?:\/\//i.test(value.url)) throw new Error('invalid MCP URL')
    const url = new globalThis.URL(value.url)
    const loopback =
      url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
    if (
      url.username ||
      url.password ||
      value.url.includes('#') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    )
      throw new Error('MCP URL must use HTTPS or loopback HTTP without user information or fragment')
    if ('headers' in value) {
      if (!strings(value.headers)) throw new Error('invalid headers')
      const names = new Set<string>()
      for (const [key, header] of Object.entries(value.headers)) {
        validateHeaderName(key)
        validateHeaderValue(key, header)
        if (names.has(key.toLowerCase())) throw new Error('duplicate HTTP header')
        names.add(key.toLowerCase())
      }
    }
  } else throw new Error('unknown MCP transport')
  return value as Server
}
