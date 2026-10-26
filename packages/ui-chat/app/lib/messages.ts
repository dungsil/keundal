import type { ChatPart } from '@keundal/chat/chat-message'

export function getMergedParts(parts: ChatPart[]): ChatPart[] {
  const result: ChatPart[] = []
  for (const part of parts) {
    const prev = result[result.length - 1]
    if (part.type === 'text' && prev?.type === 'text') {
      result[result.length - 1] = { ...part, text: prev.text + part.text }
    } else {
      result.push(part)
    }
  }
  return result
}
