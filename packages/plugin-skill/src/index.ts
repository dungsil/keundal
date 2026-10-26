import {
  SkillService,
  type ExecutionOptions,
  type SkillCatalog,
  type SkillProvider,
  type SkillSummary
} from '@keundal/core'
import type { Context } from 'cordis'

export const metadata = {
  name: { en: 'Skills', ko: '스킬' },
  description: {
    en: 'Provides reusable instructions for the agent to load when needed.',
    ko: '에이전트가 필요할 때 불러올 수 있는 재사용 가능한 지침을 제공합니다.'
  }
}

export interface SkillConfig {
  readonly providers?: readonly SkillProvider[]
}

export class RegistrySkillService extends SkillService {
  private readonly providers = new Map<string, { provider: SkillProvider; controller: AbortController }>()
  private readonly controller = new globalThis.AbortController()

  constructor(ctx: Context) {
    super(ctx)
    ctx.fiber.effect(() => () => {
      this.controller.abort(new Error('skill service disposed'))
      for (const entry of this.providers.values()) entry.controller.abort(new Error('skill provider disposed'))
      this.providers.clear()
    })
  }

  registerProvider(provider: SkillProvider): () => void {
    this.controller.signal.throwIfAborted()
    if (
      !provider ||
      typeof provider.name !== 'string' ||
      !provider.name.trim() ||
      typeof provider.prepare !== 'function'
    ) {
      throw new Error('skill provider requires a name and prepare function')
    }
    if (this.providers.has(provider.name)) throw new Error(`duplicate skill provider: ${provider.name}`)
    const entry = { provider, controller: new globalThis.AbortController() }
    this.providers.set(provider.name, entry)
    return () => {
      if (this.providers.get(provider.name) !== entry) return
      this.providers.delete(provider.name)
      entry.controller.abort(new Error(`skill provider disposed: ${provider.name}`))
    }
  }

  async prepare(options?: ExecutionOptions): Promise<SkillCatalog> {
    const signal = globalThis.AbortSignal.any([this.controller.signal, ...(options?.signal ? [options.signal] : [])])
    signal.throwIfAborted()
    const selected = new Map<string, { summary: SkillSummary; catalog: SkillCatalog; signal: AbortSignal }>()
    const providers = Array.from(this.providers.values())
    for (const { provider, controller } of providers) {
      const providerSignal = globalThis.AbortSignal.any([signal, controller.signal])
      providerSignal.throwIfAborted()
      const catalog = await provider.prepare({ signal: providerSignal })
      providerSignal.throwIfAborted()
      const names = new Set<string>()
      for (const skill of catalog.skills) {
        if (
          typeof skill.name !== 'string' ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ||
          typeof skill.description !== 'string' ||
          !skill.description.trim()
        ) {
          throw new Error(`invalid skill summary from provider: ${provider.name}`)
        }
        if (names.has(skill.name)) throw new Error(`duplicate skill name from provider ${provider.name}: ${skill.name}`)
        names.add(skill.name)
        if (!selected.has(skill.name)) {
          selected.set(skill.name, {
            summary: Object.freeze({ name: skill.name, description: skill.description }),
            catalog,
            signal: controller.signal
          })
        }
      }
    }
    signal.throwIfAborted()
    for (const entry of selected.values()) entry.signal.throwIfAborted()
    return {
      skills: Object.freeze(
        [...selected.values()]
          .map(({ summary }) => summary)
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      ),
      load: async (name, execution) => {
        const loadSignal = globalThis.AbortSignal.any([signal, ...(execution?.signal ? [execution.signal] : [])])
        loadSignal.throwIfAborted()
        const entry = selected.get(name)
        if (!entry) return undefined
        const providerSignal = globalThis.AbortSignal.any([loadSignal, entry.signal])
        providerSignal.throwIfAborted()
        const definition = await entry.catalog.load(name, { signal: providerSignal })
        providerSignal.throwIfAborted()
        if (!definition) throw new Error(`selected skill is no longer available: ${name}`)
        if (
          definition.name !== name ||
          typeof definition.description !== 'string' ||
          !definition.description.trim() ||
          typeof definition.content !== 'string' ||
          !definition.content.trim()
        ) {
          throw new Error(`invalid skill definition: ${name}`)
        }
        return { name, description: definition.description, content: definition.content }
      }
    }
  }
}

export function skillPlugin(ctx: Context, config: SkillConfig = {}) {
  const service = new RegistrySkillService(ctx)
  for (const provider of config.providers ?? []) service.registerProvider(provider)
}

export default skillPlugin
