import type {
  Base64ImageSource,
  ContentBlockParam,
  MessageCountTokensParams,
  TextBlockParam,
  Tool
} from '@anthropic-ai/sdk/resources/messages'
import { parseRunAgentInput, type AgentMessage, type LLMRequest } from '@keundal/core'

type UserContent = Exclude<Extract<AgentMessage, { role: 'user' }>['content'], string>[number]
type ConvertedMessage = { role: 'user' | 'assistant'; content: ContentBlockParam[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArguments(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value || '{}')
  } catch (error) {
    throw new Error('Anthropic tool call arguments must be a JSON object', { cause: error })
  }
  if (!isRecord(parsed)) throw new Error('Anthropic tool call arguments must be a JSON object')
  return parsed
}

function imageData(data: string | undefined, mimeType: string): Base64ImageSource {
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/gif' && mimeType !== 'image/webp') {
    throw new Error(`unsupported Anthropic image media type: ${mimeType}`)
  }
  if (!data) throw new Error('Anthropic image content requires a URL or base64 data')
  return { type: 'base64', media_type: mimeType, data }
}

function convertContent(part: UserContent): ContentBlockParam {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'image') {
    return {
      type: 'image',
      source:
        part.source.type === 'url'
          ? { type: 'url', url: part.source.value }
          : imageData(part.source.value, part.source.mimeType)
    }
  }
  if (part.type === 'binary' && part.mimeType.startsWith('image/')) {
    return {
      type: 'image',
      source: part.url ? { type: 'url', url: part.url } : imageData(part.data, part.mimeType)
    }
  }
  throw new Error(`unsupported Anthropic input content: ${part.type}`)
}

function convertReasoning(message: Extract<AgentMessage, { role: 'reasoning' }>): ContentBlockParam[] {
  if (!message.content && !message.encryptedValue) return []
  let envelope: unknown
  try {
    envelope = JSON.parse(message.encryptedValue ?? '')
  } catch (error) {
    throw new Error('Anthropic reasoning requires an Anthropic encrypted value', { cause: error })
  }
  if (!isRecord(envelope) || envelope.provider !== 'anthropic') {
    throw new Error('Anthropic reasoning requires an Anthropic encrypted value')
  }
  if (envelope.type === 'thinking' && typeof envelope.signature === 'string' && envelope.signature) {
    return [{ type: 'thinking', thinking: message.content ?? '', signature: envelope.signature }]
  }
  if (envelope.type === 'redacted_thinking' && typeof envelope.data === 'string' && envelope.data) {
    if (message.content) throw new Error('Anthropic redacted thinking cannot include readable content')
    return [{ type: 'redacted_thinking', data: envelope.data }]
  }
  throw new Error('unsupported Anthropic reasoning encrypted value')
}

function appendMessage(messages: ConvertedMessage[], message: ConvertedMessage): void {
  if (!message.content.length) return
  const previous = messages.at(-1)
  if (previous?.role === message.role) previous.content.push(...message.content)
  else messages.push(message)
}

function validateToolResults(messages: ConvertedMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    const previous = messages[index - 1]
    const pending = new Set(
      previous?.role === 'assistant'
        ? previous.content.flatMap((part) => (part.type === 'tool_use' ? [part.id] : []))
        : []
    )
    let seenContent = false
    for (const part of message.content) {
      if (part.type !== 'tool_result') {
        seenContent = true
        continue
      }
      if (seenContent) throw new Error('Anthropic tool results must precede other user content')
      if (!pending.delete(part.tool_use_id)) {
        throw new Error(`Anthropic tool result has no matching tool call: ${part.tool_use_id}`)
      }
    }
    if (pending.size) throw new Error('Anthropic tool calls require results in the next user message')
  }
}

export function createInput(
  request: LLMRequest
): Pick<MessageCountTokensParams, 'model' | 'messages' | 'system' | 'tools'> {
  const parsed = parseRunAgentInput(request.input)
  const messages: ConvertedMessage[] = []
  const system: TextBlockParam[] = []
  if (parsed.context.length) {
    appendMessage(messages, {
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify({ context: parsed.context }) }]
    })
  }
  for (const message of parsed.messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        system.push({ type: 'text', text: message.content })
        break
      case 'user':
        appendMessage(messages, {
          role: 'user',
          content:
            typeof message.content === 'string'
              ? [{ type: 'text', text: message.content }]
              : message.content.map(convertContent)
        })
        break
      case 'assistant': {
        const content: ContentBlockParam[] = []
        if (message.content) content.push({ type: 'text', text: message.content })
        for (const call of message.toolCalls ?? []) {
          if (call.encryptedValue) throw new Error('unsupported Anthropic tool call encrypted value')
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseArguments(call.function.arguments)
          })
        }
        appendMessage(messages, { role: 'assistant', content })
        break
      }
      case 'tool':
        appendMessage(messages, {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]
        })
        break
      case 'reasoning':
        appendMessage(messages, { role: 'assistant', content: convertReasoning(message) })
        break
      default:
        throw new Error(`unsupported Anthropic message role: ${message.role}`)
    }
  }
  validateToolResults(messages)
  const tools = parsed.tools.map((tool): Tool => {
    if (tool.parameters.type !== 'object') throw new Error('Anthropic tool parameters must be an object schema')
    return {
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.parameters, type: 'object' }
    }
  })
  return {
    model: request.model,
    messages,
    ...(system.length ? { system } : {}),
    ...(tools.length ? { tools } : {})
  }
}
