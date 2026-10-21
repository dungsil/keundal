import type { NativeInvoke } from '@keundal/chat/platform'
import type { McpSettingsStorage } from '@keundal/mcp'

export function createNativeMcpSettingsStorage(invoke: NativeInvoke): McpSettingsStorage {
  return {
    load: () => invoke<string | null>('load_mcp_settings'),
    async save(settings) {
      await invoke('save_mcp_settings', { settings })
    }
  }
}
