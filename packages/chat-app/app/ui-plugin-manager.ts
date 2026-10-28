import type { RuntimePluginInfo, RuntimePluginManager } from '@keundal/chat/platform'
import type { Context, Fiber, Plugin } from 'cordis'

export interface UIPluginEntry {
  module: string
  plugin: Plugin
  feature?: RuntimePluginInfo['feature']
  requires?: readonly string[]
  required?: boolean
}

const selectionKey = 'keundal:ui-plugin-selections'

/** Manages UI selections and their execution dependencies without deleting saved preferences. */
export class UIPluginManager implements RuntimePluginManager {
  private readonly fibers = new Map<string, Fiber>()
  private readonly errors = new Map<string, string>()
  private selections: Record<string, boolean> = {}
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
      storage?: Pick<Storage, 'getItem' | 'setItem'>
    },
    private readonly catalog: readonly UIPluginEntry[]
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
    return this.change(async () => {
      const saved: unknown = JSON.parse(this.options.storage?.getItem(selectionKey) ?? '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const entry of this.catalog) {
          const value = (saved as Record<string, unknown>)[entry.module]
          if (!entry.required && typeof value === 'boolean') this.selections[entry.module] = value
        }
      }
      await this.reconcile(await this.options.platform?.list() ?? [], true)
    })
  }

  private entries(platform: RuntimePluginInfo[]): RuntimePluginInfo[] {
    const entries: RuntimePluginInfo[] = [...platform, ...this.catalog.map(entry => ({
      module: entry.module,
      enabled: entry.required || this.selections[entry.module] !== false,
      required: entry.required,
      requires: [
        ...(entry.module === '@keundal/ui-layout' ? [] : ['@keundal/ui-layout']),
        ...(entry.requires ?? []),
        ...platform.filter(plugin => entry.feature && plugin.feature === entry.feature).map(plugin => plugin.module)
      ]
    }))]
    const blocked = (module: string, seen = new Set<string>()): boolean => {
      const entry = entries.find(entry => entry.module === module)
      if (!entry) return false // Remote hosts need not expose their execution catalog.
      if (!entry.enabled || entry.error || seen.has(module)) return true
      return !!entry.requires?.some(dependency => blocked(dependency, new Set([...seen, module])))
    }
    return entries.map(entry => ({
      ...entry,
      blockedBy: entry.requires?.filter(module => blocked(module)),
      ...(this.errors.has(entry.module) ? { error: this.errors.get(entry.module) } : {})
    }))
  }

  private async reconcile(plugins: RuntimePluginInfo[], startup = false): Promise<void> {
    const entries = this.entries(plugins)
    for (const entry of this.catalog) {
      const state = entries.find(plugin => plugin.module === entry.module)!
      const enabled = state.enabled && !state.blockedBy?.length &&
        (!entry.feature || plugins.find(plugin => plugin.feature === entry.feature)?.enabled !== false)
      try {
        if (enabled && !this.fibers.has(entry.module)) await this.activate(entry)
        if (!enabled) {
          await this.fibers.get(entry.module)?.dispose()
          this.fibers.delete(entry.module)
        }
        this.errors.delete(entry.module)
      } catch (error) {
        this.errors.set(entry.module, String(error))
        // A broken feature view must not hide management during startup. User changes are transactional.
        if (entry.required || !startup) throw error
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
    return this.entries(platform)
  }

  setEnabled(module: string, enabled: boolean): Promise<void> {
    return this.change(async () => {
      const plugins = (await this.options.platform?.list() ?? []).map(entry => ({ ...entry }))
      const entry = this.entries(plugins).find(entry => entry.module === module)
      if (!entry) throw new Error(`Unknown bundled plugin: ${module}`)
      if (entry.required && !enabled) throw new Error(`Required plugin cannot be disabled: ${module}`)
      if (entry.enabled === enabled && !this.errors.has(module)) return
      await this.options.stop()
      let changed = false
      const previous = { ...this.selections }
      const ui = this.catalog.some(entry => entry.module === module)
      try {
        if (ui) this.selections[module] = enabled
        else await this.options.platform!.setEnabled(module, enabled)
        changed = true
        await this.reconcile(await this.options.platform?.list() ?? [])
        if (ui) this.options.storage?.setItem(selectionKey, JSON.stringify(this.selections))
        this.errors.delete(module)
      } catch (error) {
        const rollback: unknown[] = []
        this.selections = previous
        try {
          if (changed && !ui) await this.options.platform!.setEnabled(module, entry.enabled)
        } catch (failure) {
          rollback.push(failure)
        }
        try {
          await this.reconcile(plugins)
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
