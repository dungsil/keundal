import * as agentPlugins from '@keundal/ui-agent-plugins/plugin'
import * as chat from '@keundal/ui-chat/plugin'
import * as chatList from '@keundal/ui-chat-list/plugin'
import * as composer from '@keundal/ui-composer/plugin'
import * as dictation from '@keundal/ui-dictation/plugin'
import * as home from '@keundal/ui-home/plugin'
import * as layout from '@keundal/ui-layout/plugin'
import * as mcp from '@keundal/ui-mcp/plugin'
import * as modelSelection from '@keundal/ui-model-selection/plugin'
import * as settings from '@keundal/ui-settings/plugin'
import * as settingsLlm from '@keundal/ui-settings-llm/plugin'
import * as skill from '@keundal/ui-skill/plugin'
import * as tool from '@keundal/ui-tool/plugin'
import * as trace from '@keundal/ui-trace/plugin'
import type { RuntimePluginInfo, RuntimePluginManager } from '@keundal/chat/platform'
import type { Context, Fiber, Plugin } from 'cordis'
import type { Ref } from 'vue'

export interface UIPluginEntry {
  module: string
  required?: boolean
  /** Infrastructure services are mounted by the shell before the catalog. */
  plugin?: Plugin
}

/** Static build registry: cookie values can select bundled plugins, never import arbitrary modules. */
export const uiPluginCatalog: readonly UIPluginEntry[] = [
  { module: '@keundal/ui-slots', required: true },
  { module: '@keundal/ui-runtime', required: true },
  { module: '@keundal/ui-layout', plugin: layout, required: true },
  { module: '@keundal/ui-chat-list', plugin: chatList },
  { module: '@keundal/ui-home', plugin: home },
  { module: '@keundal/ui-chat', plugin: chat },
  { module: '@keundal/ui-composer', plugin: composer },
  { module: '@keundal/ui-model-selection', plugin: modelSelection },
  { module: '@keundal/ui-dictation', plugin: dictation },
  { module: '@keundal/ui-trace', plugin: trace },
  { module: '@keundal/ui-tool', plugin: tool },
  { module: '@keundal/ui-settings', plugin: settings, required: true },
  { module: '@keundal/ui-settings-llm', plugin: settingsLlm },
  { module: '@keundal/ui-agent-plugins', plugin: agentPlugins, required: true },
  { module: '@keundal/ui-skill', plugin: skill },
  { module: '@keundal/ui-mcp', plugin: mcp }
]

/** Kept for consumers that inspect the bundled plugin registrations. */
export const uiPlugins = uiPluginCatalog.flatMap(entry => entry.plugin ? [entry.plugin] : [])

export type UIPluginSelections = Record<string, boolean>
export const uiPluginCookie = 'keundal-ui-plugins'

/** Owns live fibers, including those enabled after startup, and merges the platform's bundled catalog. */
export class UIPluginManager implements RuntimePluginManager {
  private readonly fibers = new Map<string, Fiber>()
  private readonly errors = new Map<string, string>()
  private pending: Promise<unknown> = Promise.resolve()
  private closing = false
  private disposal?: Promise<void>

  constructor(
    private readonly ctx: Context,
    private readonly options: {
      selections: Ref<UIPluginSelections | null | undefined>
      stop(): Promise<void>
      platform?: RuntimePluginManager
    },
    private readonly catalog: readonly UIPluginEntry[] = uiPluginCatalog
  ) {}

  private change(action: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new Error('UI plugin manager is closed'))
    const result = this.pending.then(action)
    this.pending = result.catch(() => {})
    return result
  }

  /** Same cookie-backed selection is used on the server and during hydration. Missing entries default to on. */
  mount(): Promise<void> {
    return this.change(async () => {
      for (const entry of this.catalog) {
        if (!entry.plugin || this.fibers.has(entry.module)) continue
        if (!entry.required && this.options.selections.value?.[entry.module] === false) continue
        try {
          await this.activate(entry)
        } catch (error) {
          this.errors.set(entry.module, String(error))
          if (entry.required) throw error
          // A failed optional view must not hide the management page.
        }
      }
    })
  }

  private async activate(entry: UIPluginEntry): Promise<void> {
    if (!entry.plugin) return
    const fiber = this.ctx.plugin(entry.plugin)
    try {
      this.fibers.set(entry.module, await fiber)
    } catch (error) {
      await fiber.dispose()
      throw error
    }
  }

  async list(): Promise<RuntimePluginInfo[]> {
    await this.pending
    const local = this.catalog.map(entry => ({
      module: entry.module,
      enabled: !entry.plugin || this.fibers.has(entry.module),
      ...(entry.required ? { required: true } : {}),
      ...(this.errors.has(entry.module) ? { error: this.errors.get(entry.module) } : {})
    }))
    const platform = await this.options.platform?.list() ?? []
    return [...local, ...platform.filter(entry => !this.catalog.some(local => local.module === entry.module))]
  }

  setEnabled(module: string, enabled: boolean): Promise<void> {
    return this.change(async () => {
      const entry = this.catalog.find(entry => entry.module === module)
      if (!entry) {
        const remote = (await this.options.platform?.list())?.find(entry => entry.module === module)
        if (!remote) throw new Error(`Unknown bundled plugin: ${module}`)
        if (remote.required && !enabled) throw new Error(`Required plugin cannot be disabled: ${module}`)
        if (remote.enabled === enabled) return
        await this.options.stop()
        await this.options.platform!.setEnabled(module, enabled)
        return
      }
      if (entry.required && !enabled) throw new Error(`Required plugin cannot be disabled: ${module}`)
      const previous = !entry.plugin || this.fibers.has(module)
      if (previous === enabled && !this.errors.has(module)) return
      await this.options.stop()
      const saved = this.options.selections.value
      try {
        if (enabled && !previous) await this.activate(entry)
        if (!enabled) {
          await this.fibers.get(module)?.dispose()
          this.fibers.delete(module)
        }
        this.options.selections.value = { ...saved, [module]: enabled }
        this.errors.delete(module)
      } catch (error) {
        // Restore both the selection and the registration, even when a setter wrote before throwing.
        const rollback: unknown[] = []
        try {
          this.options.selections.value = saved
        } catch (failure) {
          rollback.push(failure)
        }
        try {
          await this.fibers.get(module)?.dispose()
          this.fibers.delete(module)
          if (previous) await this.activate(entry)
        } catch (failure) {
          rollback.push(failure)
        }
        this.errors.set(module, String(error))
        if (rollback.length) throw new AggregateError([error, ...rollback], 'UI plugin change and rollback failed')
        throw error
      }
    })
  }

  close(): Promise<void> {
    this.closing = true
    return this.disposal ??= (async () => {
      await this.pending
      const results = await Promise.allSettled([...this.fibers.values()].toReversed().map(fiber => fiber.dispose()))
      this.fibers.clear()
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'UI plugin shutdown failed')
    })()
  }
}
