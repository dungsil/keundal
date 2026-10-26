import type { AgentMessage } from '@keundal/core'
import { z } from 'zod'

const blockFields = {
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean()
}

const presetSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    blocks: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ ...blockFields, type: z.literal('history') }).strict(),
          z
            .object({
              ...blockFields,
              type: z.literal('text'),
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string().max(100_000),
              condition: z
                .object({
                  variable: z
                    .string()
                    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
                    .max(64),
                  operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
                  value: z.string().max(20_000)
                })
                .strict()
                .optional()
            })
            .strict()
        ])
      )
      .min(1)
      .max(64),
    variables: z
      .record(
        z
          .string()
          .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
          .max(64),
        z.string().max(20_000)
      )
      .refine((value) => Object.keys(value).length <= 64, 'Too many prompt variables')
  })
  .strict()
  .superRefine((preset, ctx) => {
    if (
      preset.blocks.filter((block) => block.type === 'history').length !== 1 ||
      preset.blocks.some((block) => block.type === 'history' && !block.enabled)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Exactly one enabled history block is required' })
    }
    if (new Set(preset.blocks.map((block) => block.id)).size !== preset.blocks.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate prompt block ID' })
    }
  })

export type PromptPreset = z.infer<typeof presetSchema>
export type PromptBlock = PromptPreset['blocks'][number]

export function parsePromptPreset(value: unknown): PromptPreset {
  return presetSchema.parse(value)
}

/** Reserved IDs identify ephemeral preset messages, never conversation history. */
export const PROMPT_MESSAGE_PREFIX = 'keundal:prompt:'

/** Keep application instructions outside the editable preset and expand history exactly once. */
export function assemblePrompt(messages: readonly AgentMessage[], value: PromptPreset): AgentMessage[] {
  const preset = parsePromptPreset(value)
  const instructions = messages.filter((message) => message.role === 'system' || message.role === 'developer')
  const history = messages.filter((message) => message.role !== 'system' && message.role !== 'developer')
  return [
    ...instructions,
    ...preset.blocks.flatMap((block): AgentMessage[] => {
      if (!block.enabled) return []
      if (block.type === 'history') return history
      if (block.condition) {
        const { variable, operator, value } = block.condition
        if (!Object.hasOwn(preset.variables, variable)) throw new Error(`Unknown prompt variable: ${variable}`)
        const actual = preset.variables[variable]!
        const left = Number(actual)
        const right = Number(value)
        const numeric = actual.trim() !== '' && value.trim() !== '' && Number.isFinite(left) && Number.isFinite(right)
        const matches = {
          eq: actual === value,
          ne: actual !== value,
          gt: numeric && left > right,
          gte: numeric && left >= right,
          lt: numeric && left < right,
          lte: numeric && left <= right
        }[operator]
        if (!matches) return []
      }
      const content = block.content.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => {
        if (!Object.hasOwn(preset.variables, key)) throw new Error(`Unknown prompt variable: ${key}`)
        return preset.variables[key]!
      })
      return content.trim() ? [{ id: `${PROMPT_MESSAGE_PREFIX}${block.id}`, role: block.role, content }] : []
    })
  ]
}
