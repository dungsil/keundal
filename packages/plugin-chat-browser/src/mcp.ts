import {
  parseMcpServers,
  type McpClientConfig,
  type McpProbeResult,
  type McpRequestOptions,
  type McpSettingsStorage
} from '@keundal/mcp'
import type { McpClient } from '@keundal/plugin-mcp-client/browser'

const storageKey = 'keundal:mcp-servers'

export function createBrowserMcpSettingsStorage(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): McpSettingsStorage {
  return {
    async load() {
      return storage.getItem(storageKey)
    },
    async save(settings) {
      if (settings === null) storage.removeItem(storageKey)
      else storage.setItem(storageKey, settings)
    }
  }
}

export class McpManager {
  private servers: McpClientConfig[] = []
  private clients = new Map<string, Promise<McpClient>>()
  private lifetime = new AbortController()

  constructor(
    private readonly storage?: McpSettingsStorage,
    private readonly options: { allowStdio?: boolean } = {}
  ) {}

  get configuration(): McpClientConfig[] {
    return structuredClone(this.servers)
  }

  async load() {
    const saved = await this.storage?.load()
    this.servers = parseMcpServers(saved ? JSON.parse(saved) : [], this.options.allowStdio ?? false)
  }

  async save(value: unknown, restart: () => Promise<void>) {
    const next = parseMcpServers(value, this.options.allowStdio ?? false)
    const previous = this.configuration
    await this.persist(next)
    try {
      await restart()
      await this.close()
      this.servers = next
    } catch (error) {
      await this.persist(previous)
      throw error
    }
  }

  private async persist(servers: McpClientConfig[]) {
    await this.storage?.save(servers.length ? JSON.stringify(servers) : null)
  }

  async tools(options: McpRequestOptions = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal
    const result = []
    for (const server of this.servers) {
      signal.throwIfAborted()
      let pending = this.clients.get(server.serverName)
      if (!pending) {
        const lifetime = this.lifetime.signal
        // MCP SDK만 지연 로드하도록 허용한 예외다. 정적 import는 사용 전에도 SDK를 초기 번들에 포함한다.
        pending = import('@keundal/plugin-mcp-client/browser').then(({ McpClient }) =>
          McpClient.connect(server, { signal: lifetime })
        )
        this.clients.set(server.serverName, pending)
        void pending.catch(() => {
          if (this.clients.get(server.serverName) === pending) this.clients.delete(server.serverName)
        })
      }
      const client = await pending
      signal.throwIfAborted()
      try {
        result.push(...(await client.tools({ signal })))
      } catch (error) {
        if (signal.aborted) throw error
        this.clients.delete(server.serverName)
        await client.close().catch(() => {})
        throw error
      }
    }
    return result
  }

  /**
   * Checks a configuration that is not saved yet. It opens a temporary connection that is closed before returning,
   * never reads or changes the saved servers, and never calls a tool. Only Streamable HTTP can be checked here.
   */
  async probe(value: unknown, options: McpRequestOptions = {}): Promise<McpProbeResult> {
    const [server] = parseMcpServers([value], this.options.allowStdio ?? false)
    if (server?.transport !== 'streamable-http') throw new Error('The connection check supports Streamable HTTP only')
    // MCP SDK의 지연 로딩 예외를 연결 확인에도 적용한다.
    const { McpClient } = await import('@keundal/plugin-mcp-client/browser')
    return McpClient.probe(server, options)
  }

  async close() {
    this.lifetime.abort()
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.allSettled(clients.map(async (client) => (await client).close()))
    this.lifetime = new AbortController()
  }
}
