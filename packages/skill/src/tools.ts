import { mergeMessages, type RunAgentInput } from '@keundal/core'
import type { ExecutableTool } from '@keundal/tools'

import { type SkillCatalog } from './skill.js'

export const SKILL_CATALOG_ID = 'keundal:skill-catalog'

export function withSkillCatalog(input: RunAgentInput, catalog?: SkillCatalog): RunAgentInput {
  if (!catalog && !input.messages.some((message) => message.id === SKILL_CATALOG_ID)) return input
  const entries =
    catalog?.skills.map(
      ({ name, description }) => `- ${name}: ${description.replace(/\s+/g, ' ').trim().slice(0, 500)}`
    ) ?? []
  const content = catalog
    ? `Available skills:\n${entries.length ? entries.join('\n') : '(none)'}\nUse the skill tool to load instructions by name. Loading does not execute scripts or read supporting files.`
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
      'Load the full instructions for a skill in the available skills catalog. Does not execute scripts or read supporting files.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false
    },
    async execute(args, { signal }) {
      if (
        typeof args.name !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name) ||
        Object.keys(args).length !== 1
      ) {
        return 'Expected a single skill name matching [a-z0-9]+(?:-[a-z0-9]+)*.'
      }
      const definition = await catalog.load(args.name, { signal })
      signal.throwIfAborted()
      if (!definition) return `Unknown skill: ${args.name}. Choose a name from the available skills catalog.`
      return `<skill_content name="${args.name}">\n${definition.content}\n</skill_content>`
    }
  }
}
