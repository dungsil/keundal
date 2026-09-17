import type { FunctionDeclaration, Content, Part, Tool } from '@google/genai'
import { parseRunAgentInput, type AgentMessage, type AgentTool, type LLMRequest } from '@keundal/core'

type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>
type ToolMessage = Extract<AgentMessage, { role: 'tool' }>
type ReasoningMessage = Extract<AgentMessage, { role: 'reasoning' }>
type UserContent = Exclude<Extract<AgentMessage, { role: 'user' }>['content'], string>[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function convertContentPart(part: UserContent): Part {
  if (part.type === 'text') return { text: part.text }
  if (part.type === 'image') {
    if (part.source.type === 'url') return { fileData: { fileUri: part.source.value } }
    return { inlineData: { mimeType: part.source.mimeType, data: part.source.value } }
  }
  if (part.type === 'binary' && part.mimeType.startsWith('image/')) {
    if (part.id) return { fileData: { fileUri: part.id, mimeType: part.mimeType } }
    if (part.url) return { fileData: { fileUri: part.url, mimeType: part.mimeType } }
    return { inlineData: { mimeType: part.mimeType, data: part.data } }
  }
  throw new Error(`unsupported Gemini input content: ${part.type}`)
}

function convertToolCallArguments(arguments_: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(arguments_ || '{}')
  } catch (error) {
    throw new Error('Gemini tool call arguments must be a JSON object', { cause: error })
  }
  if (!isRecord(parsed)) throw new Error('Gemini tool call arguments must be a JSON object')
  return parsed
}

function convertAssistantMessage(message: AssistantMessage): Content | undefined {
  const parts: Part[] = []
  if (message.content) parts.push({ text: message.content })
  for (const call of message.toolCalls ?? []) {
    parts.push({
      functionCall: { name: call.function.name, args: convertToolCallArguments(call.function.arguments) },
      ...(call.encryptedValue ? { thoughtSignature: call.encryptedValue } : {})
    })
  }
  return parts.length ? { role: 'model', parts } : undefined
}

function convertToolResponse(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content)
    if (isRecord(parsed)) return parsed
  } catch {
    // Function results are free-form strings unless they carry a JSON object.
  }
  return { output: content }
}

function convertToolMessage(message: ToolMessage, callNames: Map<string, string>): Content {
  const name = callNames.get(message.toolCallId)
  if (!name) throw new Error(`Gemini tool message has no matching tool call: ${message.toolCallId}`)
  return { role: 'user', parts: [{ functionResponse: { name, response: convertToolResponse(message.content) } }] }
}

function convertReasoningMessage(message: ReasoningMessage): Content | undefined {
  if (!message.content && !message.encryptedValue) return undefined
  return {
    role: 'model',
    parts: [
      {
        thought: true,
        ...(message.content ? { text: message.content } : {}),
        ...(message.encryptedValue ? { thoughtSignature: message.encryptedValue } : {})
      }
    ]
  }
}

function convertMessage(
  message: AgentMessage,
  callNames: Map<string, string>,
  systemParts: Part[]
): Content | undefined {
  switch (message.role) {
    case 'system':
    case 'developer':
      systemParts.push({ text: message.content })
      return undefined
    case 'user':
      return {
        role: 'user',
        parts:
          typeof message.content === 'string' ? [{ text: message.content }] : message.content.map(convertContentPart)
      }
    case 'assistant':
      for (const call of message.toolCalls ?? []) callNames.set(call.id, call.function.name)
      return convertAssistantMessage(message)
    case 'tool':
      return convertToolMessage(message, callNames)
    case 'reasoning':
      return convertReasoningMessage(message)
    default:
      throw new Error(`unsupported Gemini message role: ${message.role}`)
  }
}

interface ConvertedConversation {
  readonly systemParts: Part[]
  readonly contents: Content[]
  readonly tools: readonly AgentTool[]
}

function convertConversation(request: LLMRequest): ConvertedConversation {
  const parsed = parseRunAgentInput(request.input)
  const callNames = new Map<string, string>()
  const systemParts: Part[] = []
  const contents: Content[] = []
  if (parsed.context.length) {
    contents.push({ role: 'user', parts: [{ text: JSON.stringify({ context: parsed.context }) }] })
  }
  for (const message of parsed.messages) {
    const content = convertMessage(message, callNames, systemParts)
    if (content) contents.push(content)
  }
  return { systemParts, contents, tools: parsed.tools }
}

export function createInput(request: LLMRequest): {
  systemInstruction?: Content
  contents: Content[]
  tools?: Tool[]
} {
  const { systemParts, contents, tools } = convertConversation(request)
  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } satisfies Content } : {}),
    contents,
    ...(tools.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((tool): FunctionDeclaration => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.parameters
              }))
            }
          ] satisfies Tool[]
        }
      : {})
  }
}

export function createCountInput(request: LLMRequest): { contents: Content[] } {
  const { systemParts, contents } = convertConversation(request)
  if (!systemParts.length) return { contents }
  const systemContent: Content = { role: 'user', parts: systemParts }
  return { contents: [systemContent, ...contents] }
}
