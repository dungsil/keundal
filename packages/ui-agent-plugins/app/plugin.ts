import type { Context } from 'cordis'
import type { AgentPluginSettings } from '@keundal/chat/platform'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import { lazyView } from '@keundal/ui-slots'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'

import { messages } from './locale'

export const name = 'ui-agent-plugins'
export const inject = ['slots', 'chatRuntime']

const AgentPluginSettingsSection = lazyView(
  () => import('./views/AgentPluginSettings.vue'),
  ['isAvailable', 'list', 'importFiles', 'configure', 'remove']
)

/** Add the agent plugin section to the settings page. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  // The platform and store exist only in the browser, so each callback reads them when it runs.
  const manager = () => runtime.platform.plugins!
  const stop = () => runtime.store.stop()
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'plugins',
    order: 100,
    meta: { label: localizedText(messages, 'plugin.manage'), icon: 'i-lucide-blocks', group: 'plugins' },
    inject: () => ({
      isAvailable: () => runtime.platform.plugins !== undefined,
      list: () => manager().list(),
      importFiles: (files: Record<string, string>) => manager().import(files, stop),
      configure: (name: string, settings: AgentPluginSettings) => manager().configure(name, settings, stop),
      remove: (name: string) => manager().remove(name, stop)
    })
  }, AgentPluginSettingsSection))
}
