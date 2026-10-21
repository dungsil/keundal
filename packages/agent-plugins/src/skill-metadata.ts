import type { SkillDefinition } from '@keundal/core'
import { parse } from 'yaml'

import { object, strings } from './validation.js'

export async function pluginSkill(content: string, directory: string): Promise<SkillDefinition> {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) throw new Error('YAML frontmatter is required')
  const metadata: unknown = parse(match[1])
  if (!object(metadata)) throw new Error('skill metadata must be an object')
  const { name, description } = metadata
  if (
    typeof name !== 'string' ||
    name !== directory ||
    [...name].length > 64 ||
    !/^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u.test(name)
  )
    throw new Error('invalid skill name or directory mismatch')
  if (typeof description !== 'string' || !description.trim() || [...description].length > 1024)
    throw new Error('invalid skill description')
  for (const key of ['license', 'compatibility', 'allowed-tools']) {
    if (key in metadata && typeof metadata[key] !== 'string') throw new Error(`invalid skill ${key}`)
  }
  if (
    typeof metadata.compatibility === 'string' &&
    (!metadata.compatibility.length || [...metadata.compatibility].length > 500)
  )
    throw new Error('invalid skill compatibility')
  if ('metadata' in metadata && !strings(metadata.metadata)) throw new Error('invalid skill metadata')
  const digest = /^[a-z0-9-]+$/.test(name)
    ? undefined
    : await globalThis.crypto.subtle.digest('SHA-256', new globalThis.TextEncoder().encode(name))
  const exposed = digest
    ? `skill-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 24)}`
    : name
  return { name: exposed, description, content }
}
