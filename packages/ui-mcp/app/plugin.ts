import type { Context } from 'cordis'
import type { McpRequestOptions } from '@keundal/mcp'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import { sharedText } from '@keundal/ui/app/utils/locale.ts'
import { lazyView } from '@keundal/ui-slots'

export const name = 'ui-mcp'
export const inject = ['slots', 'chatRuntime']

// 슬롯 등록은 유지하되, 정적 import로 설정 뷰를 초기 번들에 포함하지 않는다.
const McpSettingsSection = lazyView(() => import('./views/McpSettings.vue'), [
  'capabilities', 'remoteAgent', 'configuration', 'saveSettings', 'canProbe', 'probe'
])

/** Add the MCP server section to the settings page. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'mcp',
    order: 120,
    meta: { label: sharedText('plugin.servers'), icon: 'i-lucide-network', group: 'plugins' },
    // The platform exists only in the browser, so each callback reads it when it runs.
    inject: () => ({
      capabilities: runtime.capabilities,
      remoteAgent: runtime.remoteAgent,
      configuration: () => runtime.platform.mcp.configuration,
      saveSettings: (next: unknown) => runtime.saveMcpSettings(next),
      canProbe: () => typeof runtime.platform.mcp.probe === 'function',
      probe: (server: unknown, options?: McpRequestOptions) => runtime.platform.mcp.probe!(server, options)
    })
  }, McpSettingsSection))
}
