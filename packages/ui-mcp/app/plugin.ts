import type { Context } from 'cordis'
import type { McpRequestOptions } from '@keundal/mcp'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import { lazyView } from '@keundal/ui-slots'
import { sharedText } from '@keundal/ui/app/utils/locale.ts'

export const name = 'ui-mcp'
export const inject = ['slots', 'chatRuntime']

const McpSettingsSection = lazyView(
  () => import('./views/McpSettings.vue'),
  ['capabilities', 'remoteAgent', 'configuration', 'saveSettings', 'canProbe', 'probe']
)

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
