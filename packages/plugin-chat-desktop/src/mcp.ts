import type { NativeInvoke } from '@keundal/chat/platform'
import type {
  McpAuthenticationState,
  McpOAuthManager,
  McpProbeResult,
  McpRequestOptions,
  McpSettingsStorage
} from '@keundal/mcp'

export function createNativeMcpSettingsStorage(invoke: NativeInvoke): McpSettingsStorage {
  return {
    load: () => invoke<string | null>('load_mcp_settings'),
    async save(settings) {
      await invoke('save_mcp_settings', { settings })
    }
  }
}

/** The renderer receives account state only; access and refresh tokens stay in the native host. */
export function createNativeMcpOAuth(
  invoke: NativeInvoke,
  request: typeof fetch = fetch,
  changed: () => Promise<void> = async () => {
    await invoke('sidecar_current_info', { restart: true })
  }
): McpOAuthManager & {
  probe(value: unknown, options?: McpRequestOptions): Promise<McpProbeResult>
} {
  async function control<T>(
    action: string,
    serverName: string,
    options: McpRequestOptions = {},
    value?: unknown
  ): Promise<T> {
    options.signal?.throwIfAborted()
    const connection = await invoke<{ endpoint: string; token: string }>('sidecar_current_info')
    options.signal?.throwIfAborted()
    const response = await request(`${connection.endpoint}/desktop/mcp/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ serverName, value }),
      signal: options.signal
    })
    if (!response.ok) throw new Error('MCP account operation failed')
    return (await response.json()) as T
  }
  return {
    status: (name: string, options?: McpRequestOptions) => control<McpAuthenticationState>('status', name, options),
    async connect(name: string, options?: McpRequestOptions): Promise<void> {
      await control('connect', name, options)
      await changed()
    },
    async disconnect(name: string, options?: McpRequestOptions): Promise<void> {
      await control('disconnect', name, options)
      await changed()
    },
    probe: (value: unknown, options?: McpRequestOptions) => control<McpProbeResult>('probe', '', options, value)
  }
}
