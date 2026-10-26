import type { ChatPart } from '@keundal/chat/chat-message'
import type { MarkdownSource } from '@keundal/ui/app/types/markdown.ts'

type RenderPart = ChatPart & { sources?: MarkdownSource[] }

export function getMergedParts(parts: ChatPart[]): RenderPart[] {
  const result: RenderPart[] = []
  for (const part of parts) {
    const prev = result[result.length - 1]
    if (part.type === 'source-url') {
      if (prev?.type === 'text') {
        result[result.length - 1] = {
          ...prev,
          sources: [...prev.sources ?? [], { offset: prev.text.length, url: part.url }]
        }
      }
      continue
    }
    if (part.type === 'text' && prev?.type === 'text') {
      result[result.length - 1] = { ...part, text: prev.text + part.text, sources: prev.sources }
    } else {
      result.push(part)
    }
  }
  return result
}
