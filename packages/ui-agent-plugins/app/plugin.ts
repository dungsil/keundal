import type { Context } from 'cordis'
import type { AgentPluginSettings, RuntimePluginSpec } from '@keundal/chat/platform'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'

import { messages } from './locale'
import AgentPluginSettingsSection from './views/AgentPluginSettings.vue'
import RuntimePluginSettings from './views/RuntimePluginSettings.vue'

export const name = 'ui-agent-plugins'
export const inject = ['slots', 'chatRuntime']

/** Add the agent plugin section to the settings page. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  // The platform and store exist only in the browser, so each callback reads them when it runs.
  const manager = () => runtime.platform.plugins!
  const stop = () => runtime.store.stop()
  const modules = () => runtime.platform.runtimePlugins!
  const change = async (action: () => Promise<void>) => {
    await stop()
    await action()
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'runtime-plugins',
    order: 90,
    meta: { label: localizedText(messages, 'runtime.title'), icon: 'i-lucide-puzzle', group: 'plugins' },
    inject: () => ({
      isAvailable: () => runtime.platform.runtimePlugins !== undefined,
      source: () => modules().source,
      list: () => modules().list(),
      install: (spec: RuntimePluginSpec) => change(() => modules().install(spec)),
      setEnabled: (module: string, enabled: boolean) => change(() => modules().setEnabled(module, enabled)),
      remove: (module: string) => change(() => modules().remove(module))
    })
  }, RuntimePluginSettings))
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
