import type { RuntimePluginInfo, RuntimePluginManager, RuntimePluginSpec } from '@keundal/chat/platform'
import { mountRuntimePlugin, parseRuntimeModuleSpec, type RuntimeModuleImporter } from '@keundal/plugin-runtime'
import type { Context, Fiber } from 'cordis'

const key = 'keundal:runtime-plugins'

/** Optional browser modules are saved separately from the deployment's required services. */
export class BrowserRuntimePluginManager implements RuntimePluginManager {
  readonly source = 'browser' as const
  private records: RuntimePluginInfo[]
  private readonly fibers = new Map<string, Fiber>()
  private readonly errors = new Map<string, string>()
  private ctx?: Context
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly importModule: RuntimeModuleImporter = (specifier) => import(/* @vite-ignore */ specifier)
  ) {
    const saved: unknown = JSON.parse(storage.getItem(key) ?? '[]')
    if (!Array.isArray(saved)) throw new Error('Invalid runtime plugin settings')
    this.records = saved.map(({ enabled, ...spec }) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid runtime plugin enablement')
      return { ...this.parse(spec), enabled }
    })
  }

  private parse(value: unknown): RuntimePluginSpec {
    const spec = parseRuntimeModuleSpec(value)
    const url = new URL(spec.module)
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) {
      throw new Error('Browser plugins require HTTPS (or loopback HTTP) ESM URLs')
    }
    if (url.username || url.password) throw new Error('Plugin URLs must not contain credentials')
    return { ...spec, module: url.href }
  }

  private change(action: () => Promise<void>): Promise<void> {
    const result = this.pending.then(action)
    this.pending = result.catch(() => {})
    return result
  }

  async list(): Promise<RuntimePluginInfo[]> {
    await this.pending
    return this.records.map((record) => ({ ...structuredClone(record), error: this.errors.get(record.module) }))
  }

  async install(value: RuntimePluginSpec): Promise<void> {
    // Importing executes module top-level code, so installation deliberately does not import it.
    const spec = this.parse(JSON.parse(JSON.stringify(value)))
    return this.change(async () => {
      if (this.records.some((record) => record.module === spec.module)) throw new Error('Plugin already installed')
      this.save([...this.records, { ...spec, enabled: false }])
    })
  }

  setEnabled(module: string, enabled: boolean): Promise<void> {
    return this.change(async () => {
      const record = this.records.find((record) => record.module === module)
      if (!record) throw new Error('Plugin not found')
      if (enabled) {
        if (!this.ctx) throw new Error('The browser plugin runtime is not connected')
        if (!this.fibers.has(module)) {
          try {
            this.fibers.set(module, await mountRuntimePlugin(this.ctx, record, { importModule: this.importModule }))
          } catch (error) {
            this.errors.set(module, error instanceof Error ? error.message : String(error))
            throw error
          }
        }
      }
      try {
        this.save(this.records.map((item) => (item === record ? { ...record, enabled } : item)))
      } catch (error) {
        if (!record.enabled && enabled) {
          await this.fibers.get(module)?.dispose()
          this.fibers.delete(module)
        }
        throw error
      }
      if (!enabled) {
        await this.fibers.get(module)?.dispose()
        this.fibers.delete(module)
      }
      this.errors.delete(module)
    })
  }

  remove(module: string): Promise<void> {
    return this.change(async () => {
      this.save(this.records.filter((record) => record.module !== module))
      await this.fibers.get(module)?.dispose()
      this.fibers.delete(module)
      this.errors.delete(module)
    })
  }

  private save(records: RuntimePluginInfo[]) {
    this.storage.setItem(key, JSON.stringify(records))
    this.records = records
  }

  async attach(ctx: Context): Promise<void> {
    await this.close()
    this.ctx = ctx
    this.errors.clear()
    for (const record of this.records) {
      if (!record.enabled) continue
      try {
        this.fibers.set(record.module, await mountRuntimePlugin(ctx, record, { importModule: this.importModule }))
      } catch (error) {
        // A broken user extension must not prevent opening the management page to disable it.
        this.errors.set(record.module, error instanceof Error ? error.message : String(error))
      }
    }
  }

  async close(): Promise<void> {
    await this.pending
    for (const fiber of [...this.fibers.values()].reverse()) await fiber.dispose()
    this.fibers.clear()
    this.ctx = undefined
  }
}
