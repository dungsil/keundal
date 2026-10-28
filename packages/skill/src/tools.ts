import { mergeMessages, type RunAgentInput } from '@keundal/core'
import type { ExecutableTool } from '@keundal/tools'

import { isSkillResourcePath, type SkillCatalog } from './skill.js'

export const SKILL_CATALOG_ID = 'keundal:skill-catalog'

export function withSkillCatalog(input: RunAgentInput, catalog?: SkillCatalog): RunAgentInput {
  if (!catalog && !input.messages.some((message) => message.id === SKILL_CATALOG_ID)) return input
  const entries =
    catalog?.skills.map(
      ({ name, description }) => `- ${name}: ${description.replace(/\s+/g, ' ').trim().slice(0, 500)}`
    ) ?? []
  const content = catalog
    ? `Available skills:\n${entries.length ? entries.join('\n') : '(none)'}\nUse the skill tool to load instructions by name, or supply path to read a supporting file relative to that skill. Loading instructions lists resources without reading them. Reading scripts never executes them; execution requires a separate approved, isolated tool.`
    : 'Skills are disabled. The previous skill catalog is no longer available.'
  const message = { id: SKILL_CATALOG_ID, role: 'system' as const, content }
  return {
    ...input,
    messages: input.messages.some((existing) => existing.id === SKILL_CATALOG_ID)
      ? mergeMessages(input.messages, [message])
      : [message, ...input.messages]
  }
}

export function skillTool(catalog: SkillCatalog): ExecutableTool {
  return {
    name: 'skill',
    description:
      'Load skill instructions and list supporting files, or explicitly read one UTF-8 text resource using name and path. Paths are relative to the skill and restricted to references/, assets/, scripts/. Never executes scripts or grants execution permissions.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, path: { type: 'string' } },
      required: ['name'],
      additionalProperties: false
    },
    async execute(args, { signal }) {
      if (
        typeof args.name !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name) ||
        Object.keys(args).some((key) => key !== 'name' && key !== 'path') ||
        (args.path !== undefined && (typeof args.path !== 'string' || !isSkillResourcePath(args.path)))
      ) {
        return 'Expected a skill name matching [a-z0-9]+(?:-[a-z0-9]+)* and optionally a relative path under references/, assets/, or scripts/ without traversal.'
      }
      if (typeof args.path === 'string') {
        const content = await catalog.readResource?.(args.name, args.path, { signal })
        signal.throwIfAborted()
        return content === undefined
          ? `Unknown skill resource: ${args.name}/${args.path}. Load the skill to list available resources.`
          : content
      }
      const definition = await catalog.load(args.name, { signal })
      signal.throwIfAborted()
      if (!definition) return `Unknown skill: ${args.name}. Choose a name from the available skills catalog.`
      const resources = definition.resources?.length
        ? `\nSupporting files (use skill with name and path to read; scripts are not executed):\n${definition.resources.map((path) => `- ${JSON.stringify(path)}`).join('\n')}`
        : ''
      return `<skill_content name="${args.name}">\n${definition.content}\n</skill_content>${resources}`
    }
  }
}
