import type { ExecutionOptions, SkillCatalog, SkillDefinition, SkillProvider } from '@keundal/core'
import { parseSkillMarkdown } from '@keundal/plugin-skill-filesystem/markdown'
import type { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'

export const SKILL_SETTINGS_KEY = 'keundal:skills'

export const managedSkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.'),
  description: z.string().trim().min(1, 'Enter a description.'),
  content: z.string().trim().min(1, 'Enter the instructions.'),
  enabled: z.boolean()
})
export const skillSettingsSchema = z.object({
  skills: z.array(managedSkillSchema).default([]),
  disabledFiles: z.array(z.string()).default([]),
  loadLocal: z.boolean().default(true)
}).superRefine((settings, context) => {
  const names = new Set<string>()
  for (const skill of settings.skills) {
    if (names.has(skill.name)) context.addIssue({ code: 'custom', message: `Duplicate skill name: ${skill.name}` })
    names.add(skill.name)
  }
})

export type ManagedSkill = z.infer<typeof managedSkillSchema>
export type SkillSettings = z.infer<typeof skillSettingsSchema>
export interface LocalSkillFile {
  root: string
  path: string
  definition?: SkillDefinition
  error?: string
}
interface NativeSkillFiles {
  roots: string[]
  files: { root: string, path: string, markdown: string }[]
}

export class SkillManager {
  readonly providers: readonly SkillProvider[]

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly invokeNative?: typeof invoke
  ) {
    this.providers = [
      { name: 'managed', prepare: async (options) => {
        options?.signal?.throwIfAborted()
        const skills = this.load().skills.filter(skill => skill.enabled)
        return {
          skills: skills.map(({ name, description }) => ({ name, description })),
          async load(name, execution) {
            execution?.signal?.throwIfAborted()
            const skill = skills.find(skill => skill.name === name)
            return skill ? { name, description: skill.description, content: skill.content } : undefined
          }
        }
      } },
      ...(invokeNative ? [{ name: 'desktop-files', prepare: (options?: ExecutionOptions) => this.prepareLocal(options?.signal) }] : [])
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

  async listFiles(): Promise<{ roots: string[], files: LocalSkillFile[] }> {
    if (!this.invokeNative) return { roots: [], files: [] }
    const result = await this.invokeNative<NativeSkillFiles>('list_skill_files')
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
      skills: [...selected.values()].map(file => ({ name: file.definition!.name, description: file.definition!.description })),
      load: async (name, options) => {
        const combined = globalThis.AbortSignal.any([...(signal ? [signal] : []), ...(options?.signal ? [options.signal] : [])])
        combined.throwIfAborted()
        const file = selected.get(name)
        if (!file) return undefined
        const markdown = await this.invokeNative!<string>('read_skill_file', { path: file.path })
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
