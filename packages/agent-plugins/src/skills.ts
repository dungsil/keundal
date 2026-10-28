import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ExecutionOptions } from '@keundal/core'
import { isSkillResourcePath, type SkillDefinition, type SkillProvider } from '@keundal/skill'

import { contained, exists } from './files.js'
import { pluginSkill } from './skill-metadata.js'
import type { Report } from './validation.js'

export function skills(root: string, signal: AbortSignal, report: Report): SkillProvider {
  const resourceRoot = (directory: string) => contained(root, `skills/${directory}`, 'directory')
  const listResources = async (directory: string, signal: AbortSignal): Promise<string[]> => {
    const base = await resourceRoot(directory)
    const paths: string[] = []
    const visit = async (path: string) => {
      signal.throwIfAborted()
      try {
        const actual = await contained(base, path, 'directory')
        for (const entry of await readdir(actual, { withFileTypes: true })) {
          signal.throwIfAborted()
          const child = `${path}/${entry.name}`
          if (!isSkillResourcePath(child)) continue
          if (entry.isDirectory()) await visit(child)
          else if (entry.isFile() || entry.isSymbolicLink()) {
            try {
              await contained(base, child, 'file')
              paths.push(child)
            } catch (error) {
              report('skills', error instanceof Error ? error.message : String(error), child)
            }
          }
        }
      } catch (error) {
        signal.throwIfAborted()
        report('skills', error instanceof Error ? error.message : String(error), path)
      }
    }
    for (const path of ['references', 'assets', 'scripts']) {
      if (await exists(resolve(base, path))) await visit(path)
    }
    signal.throwIfAborted()
    return paths.sort()
  }
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
          const resources = await listResources(directory, loadSignal)
          return resources.length ? { ...definition, resources } : definition
        },
        async readResource(name, path, execution) {
          const readSignal = globalThis.AbortSignal.any([combined, ...(execution?.signal ? [execution.signal] : [])])
          readSignal.throwIfAborted()
          if (!isSkillResourcePath(path)) throw new Error('invalid skill resource path')
          const directory = selected.get(name)
          if (!directory) return undefined
          const base = await resourceRoot(directory)
          const target = await contained(base, path, 'file')
          if ((await stat(target)).size > 1024 * 1024) throw new Error('skill resource exceeds 1 MiB')
          const bytes = await readFile(target, { signal: readSignal })
          readSignal.throwIfAborted()
          if (bytes.length > 1024 * 1024) throw new Error('skill resource exceeds 1 MiB')
          const content = new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes)
          if (content.includes('\0')) throw new Error('skill resource must contain UTF-8 text')
          return content
        }
      }
    }
  }
}
