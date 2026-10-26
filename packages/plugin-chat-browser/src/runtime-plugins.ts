import type { RuntimePluginInfo, RuntimePluginManager } from '@keundal/chat/platform'

const key = 'keundal:bundled-plugins'

/** Only application-supplied bundled entries are selectable; saved external modules are never loaded. */
export class BrowserRuntimePluginManager implements RuntimePluginManager {
  private selections: Record<string, boolean> = {}
  private readonly errors = new Map<string, string>()
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly catalog: readonly RuntimePluginInfo[],
    private readonly apply: (module: string, enabled: boolean) => Promise<void>
  ) {
    const saved: unknown = JSON.parse(storage.getItem(key) ?? '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const entry of catalog) {
        const enabled = (saved as Record<string, unknown>)[entry.module]
        if (!entry.required && typeof enabled === 'boolean') this.selections[entry.module] = enabled
      }
    }
  }

  isEnabled(module: string): boolean {
    const entry = this.catalog.find((entry) => entry.module === module)
    if (!entry) throw new Error('Unknown bundled plugin')
    return entry.required || (this.selections[module] ?? entry.enabled)
  }

  async list(): Promise<RuntimePluginInfo[]> {
    await this.pending
    return this.catalog.map((entry) => ({
      ...entry,
      enabled: this.isEnabled(entry.module),
      error: this.errors.get(entry.module)
    }))
  }

  setEnabled(module: string, enabled: boolean): Promise<void> {
    const operation = this.pending.then(async () => {
      const entry = this.catalog.find((entry) => entry.module === module)
      if (!entry || typeof enabled !== 'boolean') throw new Error('Unknown bundled plugin selection')
      if (entry.required && !enabled) throw new Error('Required plugins cannot be disabled')
      const previous = this.isEnabled(module)
      if (previous === enabled) return
      let applied = false
      try {
        await this.apply(module, enabled)
        applied = true
        const next = { ...this.selections, [module]: enabled }
        this.storage.setItem(key, JSON.stringify(next))
        this.selections = next
        this.errors.delete(module)
      } catch (error) {
        this.errors.set(module, error instanceof Error ? error.message : String(error))
        if (applied) await this.apply(module, previous)
        throw error
      }
    })
    this.pending = operation.catch(() => {})
    return operation
  }
}
