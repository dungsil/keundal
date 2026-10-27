import type { SkillDefinition, SkillProvider } from '@keundal/skill'
import { z } from 'zod'

export const SKILL_SETTINGS_KEY = 'keundal:skills'
export const managedSkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.'),
  description: z.string().trim().min(1, 'Enter a description.'),
  content: z.string().trim().min(1, 'Enter the instructions.'),
  enabled: z.boolean()
})
export const skillSettingsSchema = z
  .object({
    skills: z.array(managedSkillSchema).default([]),
    disabledFiles: z.array(z.string()).default([]),
    loadLocal: z.boolean().default(true)
  })
  .superRefine((settings, context) => {
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
export interface SkillFiles {
  roots: string[]
  files: { root: string; path: string; markdown: string }[]
}
export interface SkillFileSource {
  list(): Promise<SkillFiles>
  read(path: string): Promise<string>
}

export interface SkillManager {
  readonly providers: readonly SkillProvider[]
  load(): SkillSettings
  save(settings: SkillSettings): SkillSettings
  listFiles(): Promise<{ roots: string[]; files: LocalSkillFile[] }>
}
