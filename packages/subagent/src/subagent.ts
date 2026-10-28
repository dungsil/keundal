import { z } from 'zod'

/** A reusable set of instructions for an independently delegated task. */
export interface SubagentRole {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly model?: string
  readonly allowedTools?: readonly string[]
  readonly maxToolRounds?: number
}

const rolesSchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/),
        description: z.string().trim().min(1).max(500),
        instructions: z.string().trim().min(1).max(20_000),
        model: z.string().trim().min(1).optional(),
        allowedTools: z.array(z.string().trim().min(1)).optional(),
        maxToolRounds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
      })
      .strict()
  )
  .max(32)
  .superRefine((roles, ctx) => {
    const names = new Set<string>()
    for (const role of roles) {
      if (names.has(role.name)) ctx.addIssue({ code: 'custom', message: 'Duplicate subagent role name' })
      names.add(role.name)
    }
  })

export function parseSubagentRoles(value: unknown): SubagentRole[] {
  return rolesSchema.parse(value)
}
