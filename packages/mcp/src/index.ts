import { createHash } from 'node:crypto'

import type { ExecutableTool } from '@keundal/agent'
import { Client, StreamableHTTPClientTransport, type RequestOptions } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import { CatalogDiscovery } from './catalog-budget.ts'
import { boundedMcpPages, DEFAULT_MAX_RESULT_BYTES, McpResultBudget, resultBytes } from './result-budget.js'

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
    }
)

export interface McpRequestOptions {
  readonly signal?: AbortSignal
}

function allows(scope: '*' | readonly string[] | undefined, name: string): boolean {
  return scope === '*' || (scope?.includes(name) ?? false)
}

function publicName(server: string, kind: 'tool' | 'resource', name: string): string {
  const raw = `mcp__${server}__${kind}__${name}`
  if (raw.length <= 64 && /^[A-Za-z0-9_-]+$/.test(raw) && !server.includes('__') && !name.includes('__')) {
    return raw
  }
  const hash = createHash('sha256')
    .update(JSON.stringify([server, kind, name]))
    .digest('hex')
    .slice(0, 12)
  return `${raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 51)}_${hash}`
}

export class McpClient {
  private readonly lifetime = new globalThis.AbortController()
  private readonly permissions: McpPermissions
  private closing?: Promise<void>
  private readonly catalog: CatalogDiscovery
  private readonly resultBudget: McpResultBudget

  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport | StreamableHTTPClientTransport,
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

  static async connect(config: McpClientConfig, options: McpRequestOptions = {}): Promise<McpClient> {
    options.signal?.throwIfAborted()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.serverName)) {
      throw new Error('serverName must contain 1-32 letters, digits, underscores or hyphens')
    }
    const timeoutMs = config.timeoutMs ?? 60_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer')
    const maxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
    if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0)
      throw new Error('maxResultBytes must be a positive integer')
    const transport =
      config.transport === 'stdio'
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: config.env,
            cwd: config.cwd,
            stderr: 'ignore'
          })
        : new StreamableHTTPClientTransport(new globalThis.URL(config.url), {
            requestInit: { headers: config.headers }
          })
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
      return new McpClient(client, transport, config.serverName, timeoutMs, config.permissions ?? {}, maxResultBytes)
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

  async tools(options: McpRequestOptions = {}): Promise<ExecutableTool[]> {
    const request = this.requestOptions(options)
    const tools: ExecutableTool[] = []
    if (this.permissions.tools === '*' || this.permissions.tools?.length) {
      const discovered = await this.catalog.run(() =>
        this.client.listTools(undefined, { ...request, cacheMode: 'bypass' })
      )
      for (const definition of discovered.tools) {
        if (!allows(this.permissions.tools, definition.name)) continue
        tools.push({
          name: publicName(this.serverName, 'tool', definition.name),
          description: definition.description ?? definition.name,
          parameters: definition.inputSchema,
          execute: async (args, context) => {
            const execution = this.requestOptions(context)
            if (definition.execution?.taskSupport === 'required') {
              throw new Error(`MCP task execution is not supported: ${definition.name}`)
            }
            const result = await this.resultBudget.run(() =>
              this.client.callTool(
                { name: definition.name, arguments: args },
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
      const resourceTool = (
        name: string,
        description: string,
        parameters: ExecutableTool['parameters'],
        execute: ExecutableTool['execute']
      ): ExecutableTool => ({ name: publicName(this.serverName, 'resource', name), description, parameters, execute })
      const emptyParameters = { type: 'object', properties: {}, additionalProperties: false }
      tools.push(
        resourceTool('list', `List permitted resources on ${this.serverName}`, emptyParameters, async (_, context) =>
          JSON.stringify(await this.listResources(context))
        ),
        resourceTool(
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
          resourceTool(
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

  async listResources(options: McpRequestOptions = {}) {
    const request = this.requestOptions(options)
    if (this.permissions.resources !== '*' && !this.permissions.resources?.length) {
      throw new Error(`MCP resource access denied: ${this.serverName}`)
    }
    if (!this.client.getServerCapabilities()?.resources) return { resources: [] }
    const pages = await boundedMcpPages(
      (cursor) =>
        this.resultBudget.run(() =>
          this.client.request({ method: 'resources/list', params: cursor === undefined ? {} : { cursor } }, request)
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
        this.resultBudget.run(() =>
          this.client.request(
            { method: 'resources/templates/list', params: cursor === undefined ? {} : { cursor } },
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
    return this.resultBudget.run(() => this.client.request({ method: 'resources/read', params: { uri } }, request))
  }

  close(): Promise<void> {
    this.lifetime.abort(new Error(`MCP client closed: ${this.serverName}`))
    return (this.closing ??= (async () => {
      try {
        if (this.transport instanceof StreamableHTTPClientTransport) await this.transport.terminateSession()
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
