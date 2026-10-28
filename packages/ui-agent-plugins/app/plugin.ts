import type { Context } from 'cordis'
import type { AgentPluginSettings, RuntimePluginSource } from '@keundal/chat/platform'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui/app/contracts/settings.ts'
import { localizedText, sharedText } from '@keundal/ui/app/utils/locale.ts'

import { messages } from './locale'
import AgentPluginSettingsSection from './views/AgentPluginSettings.vue'
import RuntimePluginSettings from './views/RuntimePluginSettings.vue'

export const name = 'ui-agent-plugins'
export const inject = ['slots', 'chatRuntime']

/** Add the agent plugin section to the settings page. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  const modules = () => runtime.pluginManager!
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'runtime-plugins',
    order: 90,
    meta: { label: localizedText(messages, 'runtime.title'), icon: 'i-lucide-puzzle', group: 'plugins' },
    inject: () => ({
      isAvailable: () => runtime.pluginManager !== undefined,
      isInstallAvailable: () => typeof runtime.pluginManager?.install === 'function',
      list: () => modules().list(),
      setEnabled: (module: string, enabled: boolean) => modules().setEnabled(module, enabled),
      install: (source: RuntimePluginSource) => {
        const manager = modules()
        if (!manager.install) throw new Error('Plugin installation is unavailable for this connection.')
        return manager.install(source)
      },
      remove: (module: string) => {
        const manager = modules()
        if (!manager.remove) throw new Error('Plugin removal is unavailable for this connection.')
        return manager.remove(module)
      }
    })
  }, RuntimePluginSettings))
}

/** Folder imports are optional; disabling them must not remove the recovery screen. */
export const agentPluginSettings = {
  name: 'ui-agent-plugin-settings',
  inject,
  apply(ctx: Context) {
    const runtime = ctx.chatRuntime
    const manager = () => runtime.platform.plugins!
    const stop = () => runtime.store.stop()
    ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'plugins',
    order: 100,
    meta: { label: sharedText('plugin.title'), icon: 'i-lucide-blocks', group: 'plugins' },
    inject: () => ({
      isAvailable: () => runtime.platform.plugins !== undefined,
      list: () => manager().list(),
      importFiles: (files: Record<string, string>) => manager().import(files, stop),
      configure: (name: string, settings: AgentPluginSettings) => manager().configure(name, settings, stop),
      remove: (name: string) => manager().remove(name, stop)
    })
    }, AgentPluginSettingsSection))
  }
}
