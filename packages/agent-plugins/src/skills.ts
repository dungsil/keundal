import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ExecutionOptions, SkillDefinition, SkillProvider } from '@keundal/core'

import { contained, exists } from './files.js'
import { pluginSkill } from './skill-metadata.js'
import type { Report } from './validation.js'

export function skills(root: string, signal: AbortSignal, report: Report): SkillProvider {
  const read = async (directory: string, options?: ExecutionOptions): Promise<SkillDefinition> => {
    const combined = globalThis.AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])])
    combined.throwIfAborted()
    const path = await contained(root, `skills/${directory}/SKILL.md`, 'file')
    const content = await readFile(path, { encoding: 'utf8', signal: combined })
    return pluginSkill(content, directory)
  }
  return {
    name: `agent-plugin:${root}`,
    async prepare(options) {
      const combined = globalThis.AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])])
      combined.throwIfAborted()
      const selected = new Map<string, string>()
      const summaries = []
      try {
        if (await exists(resolve(root, 'skills'))) {
          const path = await contained(root, 'skills', 'directory')
          for (const directory of (await readdir(path)).sort()) {
            combined.throwIfAborted()
            try {
              await contained(root, `skills/${directory}`, 'directory')
              if (!(await exists(resolve(root, 'skills', directory, 'SKILL.md')))) continue
              const definition = await read(directory, { signal: combined })
              if (selected.has(definition.name)) throw new Error('duplicate exposed skill name')
              selected.set(definition.name, directory)
              summaries.push({ name: definition.name, description: definition.description })
            } catch (error) {
              combined.throwIfAborted()
              report('skills', error instanceof Error ? error.message : String(error), directory)
            }
          }
        }
      } catch (error) {
        combined.throwIfAborted()
        report('skills', error instanceof Error ? error.message : String(error))
      }
      combined.throwIfAborted()
      return {
        skills: Object.freeze(summaries),
        async load(name, execution) {
          const loadSignal = globalThis.AbortSignal.any([combined, ...(execution?.signal ? [execution.signal] : [])])
          loadSignal.throwIfAborted()
          const directory = selected.get(name)
          if (!directory) return undefined
          const definition = await read(directory, { signal: loadSignal })
          if (definition.name !== name) throw new Error('skill name changed')
          return definition
        }
      }
    }
  }
}
