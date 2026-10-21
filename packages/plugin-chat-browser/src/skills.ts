import {
  SKILL_SETTINGS_KEY,
  skillSettingsSchema,
  type SkillSettings,
  type SkillFileSource,
  type LocalSkillFile
} from '@keundal/chat/skills'
import type { ExecutionOptions, SkillCatalog, SkillDefinition, SkillProvider } from '@keundal/core'
import { parseSkillMarkdown } from '@keundal/skill-markdown'

export class SkillManager {
  readonly providers: readonly SkillProvider[]

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly fileSource?: SkillFileSource
  ) {
    this.providers = [
      {
        name: 'managed',
        prepare: async (options) => {
          options?.signal?.throwIfAborted()
          const skills = this.load().skills.filter((skill) => skill.enabled)
          return {
            skills: skills.map(({ name, description }) => ({ name, description })),
            async load(name, execution) {
              execution?.signal?.throwIfAborted()
              const skill = skills.find((skill) => skill.name === name)
              return skill ? { name, description: skill.description, content: skill.content } : undefined
            }
          }
        }
      },
      ...(fileSource
        ? [{ name: 'local-files', prepare: (options?: ExecutionOptions) => this.prepareLocal(options?.signal) }]
        : [])
    ]
  }

  load(): SkillSettings {
    const saved = this.storage.getItem(SKILL_SETTINGS_KEY)
    return skillSettingsSchema.parse(saved === null ? {} : JSON.parse(saved))
  }

  save(settings: SkillSettings) {
    const next = skillSettingsSchema.parse(settings)
    this.storage.setItem(SKILL_SETTINGS_KEY, JSON.stringify(next))
    return next
  }

  async listFiles(): Promise<{ roots: string[]; files: LocalSkillFile[] }> {
    if (!this.fileSource) return { roots: [], files: [] }
    const result = await this.fileSource.list()
    return {
      roots: result.roots,
      files: result.files.map(({ root, path, markdown }) => {
        try {
          return { root, path, definition: parseSkillMarkdown(markdown) }
        } catch (error) {
          return { root, path, error: error instanceof Error ? error.message : String(error) }
        }
      })
    }
  }

  private async prepareLocal(signal?: AbortSignal): Promise<SkillCatalog> {
    signal?.throwIfAborted()
    const settings = this.load()
    const selected = new Map<string, LocalSkillFile>()
    if (settings.loadLocal) {
      const { files } = await this.listFiles()
      signal?.throwIfAborted()
      const names = new Map<string, Set<string>>()
      for (const file of files) {
        if (settings.disabledFiles.includes(file.path)) continue
        if (!file.definition) throw new Error(`${file.path}: ${file.error}`)
        const { name } = file.definition
        const rootNames = names.get(file.root) ?? new Set<string>()
        if (rootNames.has(name)) throw new Error(`Duplicate skill name ${name} in ${file.root}`)
        rootNames.add(name)
        names.set(file.root, rootNames)
        if (!selected.has(name)) selected.set(name, file)
      }
    }
    return {
      skills: [...selected.values()].map((file) => ({
        name: file.definition!.name,
        description: file.definition!.description
      })),
      load: async (name, options) => {
        const combined = globalThis.AbortSignal.any([
          ...(signal ? [signal] : []),
          ...(options?.signal ? [options.signal] : [])
        ])
        combined.throwIfAborted()
        const file = selected.get(name)
        if (!file) return undefined
        const markdown = await this.fileSource!.read(file.path)
        combined.throwIfAborted()
        let definition: SkillDefinition
        try {
          definition = parseSkillMarkdown(markdown)
        } catch (error) {
          throw new Error(`${file.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
        if (definition.name !== name) throw new Error(`Skill name changed in ${file.path}`)
        return definition
      }
    }
  }
}
