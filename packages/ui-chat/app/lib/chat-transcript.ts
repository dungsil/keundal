import type { ChatMessage } from '@keundal/chat/chat-message'

export const TRANSCRIPT_PAGE_SIZE = 40

export function transcriptStart(length: number, visibleCount: number) {
  return Math.max(0, length - visibleCount)
}

export function anchoredTranscriptStart(messages: readonly ChatMessage[], visibleCount: number, firstVisibleId?: string) {
  const count = firstVisibleId === undefined ? visibleCount : countToReveal(messages, visibleCount, firstVisibleId)
  return transcriptStart(messages.length, count)
}

export function messageAnchor(id: string) {
  return `message-${encodeURIComponent(id)}`
}

export function messageIdFromHash(hash: string): string | undefined {
  if (!hash.startsWith('#message-')) return
  try {
    return decodeURIComponent(hash.slice('#message-'.length))
  } catch {
    return undefined
  }
}

export function countToReveal(messages: readonly ChatMessage[], visibleCount: number, id: string) {
  const index = messages.findIndex(message => message.id === id)
  return index < 0 ? visibleCount : Math.max(visibleCount, messages.length - index)
}

export function messagePermalink(href: string, id: string) {
  const url = new globalThis.URL(href)
  url.hash = messageAnchor(id)
  return url.href
}

function plainLabel(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]<>#]/g, '\\$&')
}

export function chatMarkdown(title: string, messages: readonly ChatMessage[]): string {
  const sections = messages.map(message => {
    const parts = message.parts.flatMap(part => {
      if (part.type === 'text') return [part.text]
      // Local/blob URLs expire and attachment URLs may contain credentials.
      if (part.type === 'file') return [`[Attachment: ${plainLabel(part.filename || part.mediaType)}]`]
      return []
    })
    return `## ${message.role}\n\n${parts.join('\n\n')}`
  })
  return `# ${plainLabel(title)}\n\n${sections.join('\n\n---\n\n')}\n`
}
