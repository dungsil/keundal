import * as agentPlugins from '@keundal/ui-agent-plugins/plugin'
import * as chat from '@keundal/ui-chat/plugin'
import * as chatList from '@keundal/ui-chat-list/plugin'
import * as chart from '@keundal/ui-chart/plugin'
import * as composer from '@keundal/ui-composer/plugin'
import * as dictation from '@keundal/ui-dictation/plugin'
import * as home from '@keundal/ui-home/plugin'
import * as layout from '@keundal/ui-layout/plugin'
import * as markdown from '@keundal/ui-markdown-comark/plugin'
import * as mcp from '@keundal/ui-mcp/plugin'
import * as media from '@keundal/ui-media/plugin'
import * as modelSelection from '@keundal/ui-model-selection/plugin'
import * as settings from '@keundal/ui-settings/plugin'
import * as settingsLlm from '@keundal/ui-settings-llm/plugin'
import * as skill from '@keundal/ui-skill/plugin'
import * as subagents from '@keundal/ui-subagents/plugin'
import * as tool from '@keundal/ui-tool/plugin'
import * as trace from '@keundal/ui-trace/plugin'
import * as weather from '@keundal/ui-weather/plugin'
import type { RuntimePluginInfo, RuntimePluginManager } from '@keundal/chat/platform'
import type { Context, Fiber, Plugin } from 'cordis'

export interface UIPluginEntry {
  module: string
  plugin: Plugin
  /** Follow the functional plugin, never an independent UI preference. */
  feature?: RuntimePluginInfo['feature']
}

/** Static build registry; core views stay mounted and feature views follow their runtime services. */
export const uiPluginCatalog: readonly UIPluginEntry[] = [
  { module: '@keundal/ui-markdown-comark', plugin: markdown },
  { module: '@keundal/ui-layout', plugin: layout },
  { module: '@keundal/ui-chat-list', plugin: chatList },
  { module: '@keundal/ui-home', plugin: home },
  { module: '@keundal/ui-chat', plugin: chat },
  { module: '@keundal/ui-composer', plugin: composer },
  { module: '@keundal/ui-model-selection', plugin: modelSelection },
  { module: '@keundal/ui-dictation', plugin: dictation },
  { module: '@keundal/ui-trace', plugin: trace },
  // Shared rendering also covers search, skills, subagents and previously saved tool results.
  { module: '@keundal/ui-tool', plugin: tool },
  { module: '@keundal/ui-chart', plugin: chart },
  { module: '@keundal/ui-weather', plugin: weather },
  { module: '@keundal/ui-settings', plugin: settings },
  { module: '@keundal/ui-settings-llm', plugin: settingsLlm },
  { module: '@keundal/ui-media', plugin: media },
  { module: '@keundal/ui-subagents', plugin: subagents },
  { module: '@keundal/ui-agent-plugins', plugin: agentPlugins },
  { module: '@keundal/ui-skill', plugin: skill, feature: 'skills' },
  { module: '@keundal/ui-mcp', plugin: mcp, feature: 'mcp' }
]

/** Kept for consumers that inspect the bundled plugin registrations. */
export const uiPlugins = uiPluginCatalog.map(entry => entry.plugin)

/** Owns UI fibers while exposing only the platform's functional plugin selections. */
export class UIPluginManager implements RuntimePluginManager {
  private readonly fibers = new Map<string, Fiber>()
  private readonly errors = new Map<string, string>()
  private pending: Promise<unknown> = Promise.resolve()
  private closing = false
  private disposal?: Promise<void>
  readonly install?: RuntimePluginManager['install']
  readonly remove?: RuntimePluginManager['remove']

  constructor(
    private readonly ctx: Context,
    private readonly options: {
      stop(): Promise<void>
      platform?: RuntimePluginManager
    },
    private readonly catalog: readonly UIPluginEntry[] = uiPluginCatalog
  ) {
    if (options.platform?.install) this.install = source => this.change(async () => {
      await options.stop()
      await options.platform!.install!(source)
    })
    if (options.platform?.remove) this.remove = module => this.change(async () => {
      await options.stop()
      await options.platform!.remove!(module)
      this.errors.delete(module)
    })
  }

  private change(action: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new Error('UI plugin manager is closed'))
    const result = this.pending.then(action)
    this.pending = result.catch(() => {})
    return result
  }

  /** Mount identical defaults on the server and during hydration; sync saved functional state afterward. */
  mount(): Promise<void> {
    return this.change(() => this.reconcile([], true))
  }

  sync(): Promise<void> {
    return this.change(async () => this.reconcile(await this.options.platform?.list() ?? [], true))
  }

  private async reconcile(plugins: RuntimePluginInfo[], startup = false): Promise<void> {
    for (const entry of this.catalog) {
      const enabled = !entry.feature || plugins.find(plugin => plugin.feature === entry.feature)?.enabled !== false
      try {
        if (enabled && !this.fibers.has(entry.module)) await this.activate(entry)
        if (!enabled) {
          await this.fibers.get(entry.module)?.dispose()
          this.fibers.delete(entry.module)
        }
        if (entry.feature) this.errors.delete(entry.feature)
      } catch (error) {
        if (entry.feature) this.errors.set(entry.feature, String(error))
        // A broken feature view must not hide management during startup. User changes are transactional.
        if (!entry.feature || !startup) throw error
      }
    }
  }

  private async activate(entry: UIPluginEntry): Promise<void> {
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
    const platform = await this.options.platform?.list() ?? []
    return platform.map(entry => ({
      ...entry,
      ...(this.errors.has(entry.feature ?? entry.module) ? { error: this.errors.get(entry.feature ?? entry.module) } : {})
    }))
  }

  setEnabled(module: string, enabled: boolean): Promise<void> {
    return this.change(async () => {
      const plugins = (await this.options.platform?.list() ?? []).map(entry => ({ ...entry }))
      const entry = plugins.find(entry => entry.module === module)
      if (!entry) throw new Error(`Unknown bundled plugin: ${module}`)
      if (entry.required && !enabled) throw new Error(`Required plugin cannot be disabled: ${module}`)
      if (entry.enabled === enabled && !this.errors.has(entry.feature ?? module)) return
      await this.options.stop()
      let changed = false
      try {
        await this.options.platform!.setEnabled(module, enabled)
        changed = true
        await this.reconcile(await this.options.platform!.list())
        this.errors.delete(entry.feature ?? module)
      } catch (error) {
        const rollback: unknown[] = []
        try {
          if (changed) await this.options.platform!.setEnabled(module, entry.enabled)
        } catch (failure) {
          rollback.push(failure)
        }
        try {
          await this.reconcile(plugins)
        } catch (failure) {
          rollback.push(failure)
        }
        this.errors.set(entry.feature ?? module, String(error))
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
