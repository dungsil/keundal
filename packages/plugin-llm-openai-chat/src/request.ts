import { parseReasoning, parseRunAgentInput, type AgentMessage, type LLMRequest } from '@keundal/core'
import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool
} from 'openai/resources/chat/completions'

type UserContent = Exclude<Extract<AgentMessage, { role: 'user' }>['content'], string>[number]
type ToolCall = NonNullable<Extract<AgentMessage, { role: 'assistant' }>['toolCalls']>[number]

function convertContent(part: UserContent): ChatCompletionContentPart {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'image') {
    // Chat Completions는 파일 ID 입력을 받지 않습니다.
    if (part.source.type === 'file') throw new Error('unsupported OpenAI Chat Completions input content: file')
    return {
      type: 'image_url',
      image_url: {
        url: part.source.type === 'url' ? part.source.value : `data:${part.source.mimeType};base64,${part.source.value}`
      }
    }
  }
  throw new Error(`unsupported OpenAI Chat Completions input content: ${part.type}`)
}

function convertToolCall(call: ToolCall): ChatCompletionMessageToolCall {
  return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }
}

/** Chat Completions의 도구 결과는 텍스트만 받습니다. 미디어 결과는 조용히 버리지 않고 알립니다. */
function convertToolContent(parts: Exclude<Extract<AgentMessage, { role: 'tool' }>['content'], string>): string {
  return parts
    .map((part) => {
      if (part.type !== 'text') throw new Error(`unsupported OpenAI Chat Completions tool content: ${part.type}`)
      return part.text
    })
    .join('')
}

/** 도구 결과는 앞선 도구 호출이 있어야 의미가 있습니다. 호출 없는 결과를 공급자 요청 전에 거부합니다. */
function validateToolResults(messages: ChatCompletionMessageParam[]): void {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      pending.clear()
      for (const call of message.tool_calls ?? []) pending.add(call.id)
      continue
    }
    if (message.role !== 'tool') continue
    if (!pending.delete(message.tool_call_id)) {
      throw new Error(`tool call result has no matching tool call: ${message.tool_call_id}`)
    }
  }
}

export function createInput(
  request: LLMRequest
): Pick<ChatCompletionCreateParams, 'model' | 'messages' | 'tools' | 'reasoning_effort'> {
  parseReasoning(request.reasoning)
  if (request.webSearch) throw new Error('OpenAI Chat Completions does not support native web search')
  const parsed = parseRunAgentInput(request.input)
  const messages: ChatCompletionMessageParam[] = []
  if (parsed.context.length) {
    messages.push({ role: 'user', content: JSON.stringify({ context: parsed.context }) })
  }
  for (const message of parsed.messages) {
    switch (message.role) {
      case 'system':
        messages.push({ role: 'system', content: message.content })
        break
      case 'developer':
        messages.push({ role: 'developer', content: message.content })
        break
      case 'user':
        messages.push({
          role: 'user',
          content:
            typeof message.content === 'string' ? message.content : message.content.map((part) => convertContent(part))
        })
        break
      case 'assistant': {
        const calls = message.toolCalls ?? []
        // 도구 전용 호스트가 빈 텍스트를 가질 수 있으므로 내용이 없으면 생략합니다.
        messages.push({
          role: 'assistant',
          ...(message.content ? { content: message.content } : {}),
          ...(calls.length ? { tool_calls: calls.map((call) => convertToolCall(call)) } : {})
        })
        break
      }
      case 'tool':
        messages.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: typeof message.content === 'string' ? message.content : convertToolContent(message.content)
        })
        break
      case 'reasoning':
        // Chat Completions는 추론 항목을 입력으로 받지 않습니다. 모델이 내부적으로 다시 계산합니다.
        break
      default:
        throw new Error(`unsupported OpenAI Chat Completions message role: ${message.role}`)
    }
  }
  validateToolResults(messages)
  const tools: ChatCompletionTool[] = parsed.tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }))
  return {
    model: request.model,
    messages,
    tools,
    ...(request.reasoning === undefined || request.reasoning === false
      ? {}
      : { reasoning_effort: request.reasoning === true ? 'medium' : request.reasoning })
  }
}
