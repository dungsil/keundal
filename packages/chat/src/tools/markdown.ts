import { z } from 'zod'

import type { ToolPart } from '../chat-message'

export const markdownSchema = z.object({
  content: z.string().min(1).describe('Markdown content to display to the user')
})

/** Only complete, non-failed markdown calls contribute visible content. */
export function getMarkdownContent(part: ToolPart): string | undefined {
  if (part.type !== 'tool-markdown' || (part.state !== 'input-available' && part.state !== 'output-available')) return
  const parsed = markdownSchema.safeParse(part.input)
  return parsed.success ? parsed.data.content : undefined
}
