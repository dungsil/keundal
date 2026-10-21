import { McpClient, parseMcpServers, type McpClientConfig, type McpRequestOptions } from '@keundal/mcp/browser'
import type { invoke } from '@tauri-apps/api/core'

const storageKey = 'keundal:mcp-servers'

export class McpManager {
  private servers: McpClientConfig[] = []
  private clients = new Map<string, Promise<McpClient>>()
  private lifetime = new AbortController()

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly invokeNative?: typeof invoke
  ) {}

  get configuration(): McpClientConfig[] { return structuredClone(this.servers) }

  async load() {
    const saved = this.invokeNative
      ? await this.invokeNative<string | null>('load_mcp_settings')
      : this.storage.getItem(storageKey)
    this.servers = parseMcpServers(saved ? JSON.parse(saved) : [], !!this.invokeNative)
  }

  async save(value: unknown, restart: () => Promise<void>) {
    const next = parseMcpServers(value, !!this.invokeNative)
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
    if (this.invokeNative) await this.invokeNative('save_mcp_settings', { settings: servers.length ? JSON.stringify(servers) : null })
    else if (servers.length) this.storage.setItem(storageKey, JSON.stringify(servers))
    else this.storage.removeItem(storageKey)
  }

  async tools(options: McpRequestOptions = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal
    const result = []
    for (const server of this.servers) {
      signal.throwIfAborted()
      let pending = this.clients.get(server.serverName)
      if (!pending) {
        pending = McpClient.connect(server, { signal })
        this.clients.set(server.serverName, pending)
        void pending.catch(() => {
          if (this.clients.get(server.serverName) === pending) this.clients.delete(server.serverName)
        })
      }
      const client = await pending
      try {
        result.push(...await client.tools({ signal }))
      } catch (error) {
        if (signal.aborted) throw error
        this.clients.delete(server.serverName)
        await client.close().catch(() => {})
        throw error
      }
    }
    return result
  }

  async close() {
    this.lifetime.abort()
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.allSettled(clients.map(async client => (await client).close()))
    this.lifetime = new AbortController()
  }
}
