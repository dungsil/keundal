import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ExecutionOptions, SkillCatalog, SkillDefinition, SkillProvider } from '@keundal/core'
import type { Context } from 'cordis'

import { parseSkillMarkdown } from './markdown.js'

export interface FilesystemSkillConfig {
  readonly roots: readonly string[]
  readonly name?: string
}

async function readSkill(path: string, options?: ExecutionOptions): Promise<SkillDefinition> {
  options?.signal?.throwIfAborted()
  try {
    const text = await readFile(path, { encoding: 'utf8', signal: options?.signal })
    options?.signal?.throwIfAborted()
    return parseSkillMarkdown(text)
  } catch (cause) {
    options?.signal?.throwIfAborted()
    throw new Error(`failed to read skill ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause
    })
  }
}

export function createFilesystemSkillProvider(config: FilesystemSkillConfig): SkillProvider {
  if (
    !Array.isArray(config.roots) ||
    !config.roots.length ||
    config.roots.some((root) => typeof root !== 'string' || !root.trim())
  ) {
    throw new Error('skill roots must be a non-empty array of paths')
  }
  const roots = config.roots.map((root) => resolve(root))
  const name = config.name ?? 'filesystem'
  if (typeof name !== 'string' || !name.trim()) throw new Error('skill provider name must not be empty')
  return {
    name,
    async prepare(options): Promise<SkillCatalog> {
      const paths = new Map<string, string>()
      const skills = []
      for (const root of roots) {
        options?.signal?.throwIfAborted()
        const entries = await readdir(root, { withFileTypes: true })
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of entries) {
          options?.signal?.throwIfAborted()
          if (!entry.isDirectory()) continue
          const directory = resolve(root, entry.name)
          const files = await readdir(directory)
          if (!files.includes('SKILL.md')) continue
          const path = resolve(directory, 'SKILL.md')
          const { name, description } = await readSkill(path, options)
          if (paths.has(name)) throw new Error(`duplicate skill name ${name}: ${paths.get(name)}, ${path}`)
          paths.set(name, path)
          skills.push(Object.freeze({ name, description }))
        }
      }
      options?.signal?.throwIfAborted()
      return {
        skills: Object.freeze(skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))),
        async load(name, execution) {
          const signal = globalThis.AbortSignal.any([
            ...(options?.signal ? [options.signal] : []),
            ...(execution?.signal ? [execution.signal] : [])
          ])
          signal.throwIfAborted()
          const path = paths.get(name)
          if (!path) return undefined
          const definition = await readSkill(path, { signal })
          if (definition.name !== name)
            throw new Error(`skill name changed in ${path}: expected ${name}, found ${definition.name}`)
          return definition
        }
      }
    }
  }
}

export const filesystemSkillPlugin = Object.assign(
  function filesystemSkillPlugin(ctx: Context, config: FilesystemSkillConfig) {
    const provider = createFilesystemSkillProvider(config)
    ctx.fiber.effect(() => ctx.skills.registerProvider(provider))
  },
  { inject: ['skills'] }
)

export default filesystemSkillPlugin
