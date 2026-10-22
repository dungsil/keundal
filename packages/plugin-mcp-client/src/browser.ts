export { parseMcpServers } from '@keundal/mcp'
import { parseMcpHttpUrl } from '@keundal/mcp'
import type { McpPermissions, McpClientConfig, McpProbeResult, McpRequestOptions, McpToolSummary } from '@keundal/mcp'
import type { ExecutableTool } from '@keundal/tools'
import { Client, StreamableHTTPClientTransport, type RequestOptions } from '@modelcontextprotocol/client'
import type { Transport } from '@modelcontextprotocol/client'

import { CatalogDiscovery } from './catalog-budget.js'
import { createHttpTransport } from './http-transport.js'
import { boundedMcpPages, DEFAULT_MAX_RESULT_BYTES, McpResultBudget, resultBytes } from './result-budget.js'
export type { McpPermissions, McpClientConfig, McpProbeResult, McpRequestOptions, McpToolSummary } from '@keundal/mcp'

function allows(scope: '*' | readonly string[] | undefined, name: string): boolean {
  return scope === '*' || (scope?.includes(name) ?? false)
}

const PROBE_REQUEST_MARGIN_MS = 1000
const PROBE_CLOSE_GRACE_MS = 3000

async function closeWithin(client: { close(): Promise<void> }, ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = globalThis.setTimeout(resolve, ms)
  try {
    await Promise.race([client.close().catch(() => {}), promise])
  } finally {
    globalThis.clearTimeout(timer)
  }
}

async function publicName(server: string, kind: 'tool' | 'resource', name: string): Promise<string> {
  const raw = `mcp__${server}__${kind}__${name}`
  if (raw.length <= 64 && /^[A-Za-z0-9_-]+$/.test(raw) && !server.includes('__') && !name.includes('__')) {
    return raw
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new globalThis.TextEncoder().encode(JSON.stringify([server, kind, name]))
  )
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
  return `${raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 51)}_${hash}`
}

export class McpClient {
  private readonly lifetime = new globalThis.AbortController()
  private readonly permissions: McpPermissions
  private closing?: Promise<void>
  private readonly catalog: CatalogDiscovery
  private readonly resultBudget: McpResultBudget

  protected constructor(
    private readonly client: Client,
    private readonly transport: Transport,
    readonly serverName: string,
    private readonly timeoutMs: number,
    permissions: McpPermissions,
    private readonly maxResultBytes: number
  ) {
    this.resultBudget = new McpResultBudget(transport, maxResultBytes)
    this.catalog = new CatalogDiscovery(transport)
    this.permissions = {
      tools: permissions.tools === '*' ? '*' : [...(permissions.tools ?? [])],
      resources: permissions.resources === '*' ? '*' : [...(permissions.resources ?? [])]
    }
    client.onclose = () => this.lifetime.abort(new Error(`MCP server disconnected: ${serverName}`))
  }

  static async connect(
    config: McpClientConfig,
    options: McpRequestOptions = {},
    createTransport?: (config: McpClientConfig) => Transport
  ): Promise<McpClient> {
    options.signal?.throwIfAborted()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.serverName)) {
      throw new Error('serverName must contain 1-32 letters, digits, underscores or hyphens')
    }
    const timeoutMs = config.timeoutMs ?? 60_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer')
    const maxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
    if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0)
      throw new Error('maxResultBytes must be a positive integer')
    if (config.transport === 'stdio' && !createTransport) throw new Error('stdio requires the Node.js MCP client')
    if (config.transport === 'streamable-http') parseMcpHttpUrl(config.url, config.allowInsecureHttp)
    const transport = createTransport
      ? createTransport(config)
      : createHttpTransport(config as Extract<McpClientConfig, { transport: 'streamable-http' }>)
    const client = new Client(
      { name: 'keundal-mcp-client', version: '0.0.0' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } }
    )
    let closing: Promise<void> | undefined
    const abort = () => {
      closing ??= transport.close()
      void closing.catch(() => {})
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      await client.connect(transport, { signal: options.signal, timeout: timeoutMs })
      options.signal?.throwIfAborted()
      return new this(client, transport, config.serverName, timeoutMs, config.permissions ?? {}, maxResultBytes)
    } catch (error) {
      await closing
      await client.close()
      await transport.close()
      options.signal?.throwIfAborted()
      throw error
    } finally {
      options.signal?.removeEventListener('abort', abort)
    }
  }

  /**
   * Connects with the given configuration, reports what the server offers, and always closes the connection.
   * The whole check, including the connection, ends after `timeoutMs` and when `options.signal` aborts.
   */
  static async probe(config: McpClientConfig, options: McpRequestOptions = {}): Promise<McpProbeResult> {
    const timeoutMs = config.timeoutMs ?? 60_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer')
    const deadline = globalThis.AbortSignal.timeout(timeoutMs)
    const signal = options.signal ? globalThis.AbortSignal.any([options.signal, deadline]) : deadline
    let client: McpClient | undefined
    try {
      // The deadline bounds the whole check, so each request gets a little longer and the deadline reports first.
      client = await this.connect(
        { ...config, timeoutMs: timeoutMs + PROBE_REQUEST_MARGIN_MS, permissions: {} },
        { signal }
      )
      return await client.inspect({ signal })
    } catch (error) {
      if (deadline.aborted && !options.signal?.aborted) throw deadline.reason
      throw error
    } finally {
      // A server that stopped answering must not keep the check pending while the session is terminated.
      if (client) await closeWithin(client, PROBE_CLOSE_GRACE_MS)
    }
  }

  async tools(options: McpRequestOptions = {}): Promise<ExecutableTool[]> {
    const request = this.requestOptions(options)
    const tools: ExecutableTool[] = []
    if (this.permissions.tools === '*' || this.permissions.tools?.length) {
      const discovered = await this.catalog.run((_meta) =>
        this.client.listTools({ _meta }, { ...request, cacheMode: 'bypass' })
      )
      for (const definition of discovered.tools) {
        if (!allows(this.permissions.tools, definition.name)) continue
        tools.push({
          name: await publicName(this.serverName, 'tool', definition.name),
          description: definition.description ?? definition.name,
          parameters: definition.inputSchema,
          execute: async (args, context) => {
            const execution = this.requestOptions(context)
            if (definition.execution?.taskSupport === 'required') {
              throw new Error(`MCP task execution is not supported: ${definition.name}`)
            }
            const result = await this.resultBudget.run((_meta) =>
              this.client.callTool(
                { name: definition.name, arguments: args, _meta },
                { ...execution, toolDefinition: definition }
              )
            )
            if (result.isError) throw new Error(`MCP tool failed: ${JSON.stringify(result)}`)
            return JSON.stringify(result)
          }
        })
      }
    }
    if (
      this.client.getServerCapabilities()?.resources &&
      (this.permissions.resources === '*' || this.permissions.resources?.length)
    ) {
      const resourceTool = async (
        name: string,
        description: string,
        parameters: ExecutableTool['parameters'],
        execute: ExecutableTool['execute']
      ): Promise<ExecutableTool> => ({
        name: await publicName(this.serverName, 'resource', name),
        description,
        parameters,
        execute
      })
      const emptyParameters = { type: 'object', properties: {}, additionalProperties: false }
      tools.push(
        await resourceTool(
          'list',
          `List permitted resources on ${this.serverName}`,
          emptyParameters,
          async (_, context) => JSON.stringify(await this.listResources(context))
        ),
        await resourceTool(
          'read',
          `Read a permitted resource URI on ${this.serverName}`,
          {
            type: 'object',
            properties: { uri: { type: 'string' } },
            required: ['uri'],
            additionalProperties: false
          },
          async (args, context) => {
            if (typeof args.uri !== 'string') throw new Error('uri must be a string')
            return JSON.stringify(await this.readResource(args.uri, context))
          }
        )
      )
      if (this.permissions.resources === '*') {
        tools.push(
          await resourceTool(
            'templates',
            `List resource templates on ${this.serverName}; expand a template URI before reading`,
            emptyParameters,
            async (_, context) => JSON.stringify(await this.listResourceTemplates(context))
          )
        )
      }
    }
    const names = new Set<string>()
    for (const tool of tools) {
      if (names.has(tool.name)) throw new Error(`duplicate MCP tool name: ${tool.name}`)
      names.add(tool.name)
    }
    request.signal?.throwIfAborted()
    return tools
  }

  /**
   * Lists the tool names and resource availability the server reports, ignoring the configured permissions.
   * It builds no executable tool, so nothing listed here can be called through this method.
   */
  async inspect(options: McpRequestOptions = {}): Promise<McpProbeResult> {
    const request = this.requestOptions(options)
    const capabilities = this.client.getServerCapabilities()
    const tools: McpToolSummary[] = []
    if (capabilities?.tools) {
      const discovered = await this.catalog.run((_meta) =>
        this.client.listTools({ _meta }, { ...request, cacheMode: 'bypass' })
      )
      for (const { name, description } of discovered.tools)
        tools.push({ name, ...(description ? { description } : {}) })
    }
    let count = 0
    if (capabilities?.resources) {
      const pages = await boundedMcpPages(
        (cursor) =>
          this.resultBudget.run((_meta) =>
            this.client.request(
              { method: 'resources/list', params: { _meta, ...(cursor === undefined ? {} : { cursor }) } },
              request
            )
          ),
        (page) => page.resources,
        this.maxResultBytes
      )
      count = pages.items.length
    }
    request.signal?.throwIfAborted()
    return { tools, resources: { supported: Boolean(capabilities?.resources), count } }
  }

  async listResources(options: McpRequestOptions = {}) {
    const request = this.requestOptions(options)
    if (this.permissions.resources !== '*' && !this.permissions.resources?.length) {
      throw new Error(`MCP resource access denied: ${this.serverName}`)
    }
    if (!this.client.getServerCapabilities()?.resources) return { resources: [] }
    const pages = await boundedMcpPages(
      (cursor) =>
        this.resultBudget.run((_meta) =>
          this.client.request(
            { method: 'resources/list', params: { _meta, ...(cursor === undefined ? {} : { cursor }) } },
            request
          )
        ),
      (page) => page.resources,
      this.maxResultBytes
    )
    const { nextCursor: _cursor, ...first } = pages.first
    const result = {
      ...first,
      resources: pages.items.filter((resource) => allows(this.permissions.resources, resource.uri))
    }
    resultBytes(result, this.maxResultBytes)
    return result
  }

  async listResourceTemplates(options: McpRequestOptions = {}) {
    const request = this.requestOptions(options)
    if (this.permissions.resources !== '*') throw new Error(`MCP resource template access denied: ${this.serverName}`)
    if (!this.client.getServerCapabilities()?.resources) return { resourceTemplates: [] }
    const pages = await boundedMcpPages(
      (cursor) =>
        this.resultBudget.run((_meta) =>
          this.client.request(
            { method: 'resources/templates/list', params: { _meta, ...(cursor === undefined ? {} : { cursor }) } },
            request
          )
        ),
      (page) => page.resourceTemplates,
      this.maxResultBytes
    )
    const { nextCursor: _cursor, ...first } = pages.first
    const result = { ...first, resourceTemplates: pages.items }
    resultBytes(result, this.maxResultBytes)
    return result
  }

  async readResource(uri: string, options: McpRequestOptions = {}) {
    const request = this.requestOptions(options)
    if (!allows(this.permissions.resources, uri)) throw new Error(`MCP resource access denied: ${uri}`)
    return this.resultBudget.run((_meta) =>
      this.client.request({ method: 'resources/read', params: { uri, _meta } }, request)
    )
  }

  close(): Promise<void> {
    const disconnected = this.lifetime.signal.aborted
    this.lifetime.abort(new Error(`MCP client closed: ${this.serverName}`))
    return (this.closing ??= (async () => {
      try {
        if (!disconnected && this.transport instanceof StreamableHTTPClientTransport)
          await this.transport.terminateSession()
      } finally {
        await this.client.close()
      }
    })())
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private requestOptions(options: McpRequestOptions): RequestOptions {
    const signal = options.signal
      ? globalThis.AbortSignal.any([this.lifetime.signal, options.signal])
      : this.lifetime.signal
    signal.throwIfAborted()
    return { signal, timeout: this.timeoutMs }
  }
}
