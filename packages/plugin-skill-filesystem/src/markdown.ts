import type { SkillDefinition } from '@keundal/core'
import { parse } from 'yaml'

export function parseSkillMarkdown(text: string): SkillDefinition {
  text = text.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error('YAML frontmatter is required')
  const metadata: unknown = parse(match[1])
  if (typeof metadata !== 'object' || metadata === null || !('name' in metadata) || !('description' in metadata)) {
    throw new Error('name and description are required')
  }
  const { name, description } = metadata
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('invalid skill name')
  if (typeof description !== 'string' || !description.trim()) throw new Error('description must be a non-empty string')
  const content = text.slice(match[0].length).trim()
  if (!content) throw new Error('skill content must not be empty')
  return { name, description, content }
}
