import { parseRunAgentInput, prepareReplayMessages, type AgentMessage } from '@keundal/core'

import type { ChatMessage } from './chat-message'
import { resolveModel } from './models'
const randomUUID = () => globalThis.crypto.randomUUID()
const input = (
  messages: AgentMessage[],
  threadId: string = randomUUID(),
  runId: string = randomUUID(),
  state: unknown = {}
) => ({ threadId, runId, state, context: [], tools: [], messages })

export function toMessages(messages: ChatMessage[], model: string): AgentMessage[] {
  return messages.flatMap((message): AgentMessage[] => {
    // Keep existing IndexedDB conversations readable, including opaque reasoning
    // and native search blocks. Never send one model's state to another.
    const saved = message.parts.find((part) => part.type === 'data-keundal')
    if (message.role === 'assistant' && saved?.type === 'data-keundal') {
      const data = saved.data
      const parsed = parseRunAgentInput(input(data.messages)).messages
      return prepareReplayMessages(parsed, resolveModel(data.model).value, resolveModel(model).value)
    }
    if (message.role === 'user') {
      const content: Exclude<Extract<AgentMessage, { role: 'user' }>['content'], string> = []
      for (const part of message.parts) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text })
        else if (part.type === 'file') {
          if (!part.mediaType.startsWith('image/'))
            throw new Error(`Keundal does not support this attachment: ${part.mediaType}`)
          const match = /^data:([^;]+);base64,(.*)$/s.exec(part.url)
          content.push({
            type: 'image',
            source: match
              ? { type: 'data', mimeType: match[1]!, value: match[2]! }
              : { type: 'url', value: part.url, mimeType: part.mediaType }
          })
        }
      }
      return [{ id: message.id, role: 'user', content }]
    }
    return message.parts.flatMap((part, index): AgentMessage[] =>
      part.type === 'text' ? [{ id: `${message.id}-${index}`, role: message.role, content: part.text }] : []
    )
  })
}
