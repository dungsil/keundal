import { parseRunAgentInput, type AgentMessage, type LLMRequest } from '@keundal/core'
import type {
  ResponseInput,
  ResponseInputContent,
  ResponseCreateParamsBase
} from 'openai/resources/responses/responses'

type UserContent = Exclude<Extract<AgentMessage, { role: 'user' }>['content'], string>[number]

function convertContent(part: UserContent): ResponseInputContent {
  if (part.type === 'text') return { type: 'input_text', text: part.text }
  if (part.type === 'image') {
    if (part.source.type === 'file') {
      return { type: 'input_image', detail: 'auto', file_id: part.source.value }
    }
    return {
      type: 'input_image',
      detail: 'auto',
      image_url:
        part.source.type === 'url' ? part.source.value : `data:${part.source.mimeType};base64,${part.source.value}`
    }
  }
  throw new Error(`unsupported OpenAI input content: ${part.type}`)
}

function convertMessage(message: AgentMessage): ResponseInput {
  switch (message.role) {
    case 'system':
    case 'developer':
      return [{ role: message.role, content: message.content }]
    case 'user':
      return [
        {
          role: 'user',
          content: typeof message.content === 'string' ? message.content : message.content.map(convertContent)
        }
      ]
    case 'assistant': {
      const items: ResponseInput = []
      // 도구 전용 호스트가 빈 텍스트를 가질 수 있으므로 내용이 없으면 message 항목을 만들지 않습니다.
      if (message.content) {
        const phase: unknown = message.metadata?.['openai.phase']
        if (phase === 'commentary' || phase === 'final_answer') {
          items.push({
            type: 'message',
            id: message.id,
            role: 'assistant',
            status: 'completed',
            phase,
            content: [{ type: 'output_text', text: message.content, annotations: [] }]
          })
        } else {
          items.push({ role: 'assistant', content: message.content })
        }
      }
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
        })
      }
      return items
    }
    case 'tool':
      return [
        {
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: typeof message.content === 'string' ? message.content : message.content.map(convertContent)
        }
      ]
    case 'reasoning':
      // store: false로 요청할 때 추론 항목은 encrypted_content 없이 다시 보낼 수 없습니다. 스트림이
      // 끊겨 암호화 값을 받지 못한 추론을 요약만 담아 보내면 이후 요청이 모두 거부되므로 제외합니다.
      if (!message.encryptedValue) return []
      return [
        {
          type: 'reasoning',
          id: message.id,
          summary: message.content ? [{ type: 'summary_text', text: message.content }] : [],
          encrypted_content: message.encryptedValue
        }
      ]
    default:
      throw new Error(`unsupported OpenAI message role: ${message.role}`)
  }
}

export function createInput(request: LLMRequest): Pick<ResponseCreateParamsBase, 'model' | 'input' | 'tools'> {
  const parsed = parseRunAgentInput(request.input)
  const input: ResponseInput = []
  if (parsed.context.length) {
    input.push({ role: 'user', content: JSON.stringify({ context: parsed.context }) })
  }
  // 도구 결과는 앞선 도구 호출이 있어야 의미가 있습니다. Gemini·Anthropic 변환기처럼 호출 없는
  // 결과를 공급자 요청 전에 거부해, 오류 발견 지점이 공급자로 밀리지 않게 합니다.
  const seen = new Set<string>()
  for (const message of parsed.messages) {
    for (const item of convertMessage(message)) {
      if ('call_id' in item && typeof item.call_id === 'string') {
        if (item.type === 'function_call') {
          seen.add(item.call_id)
        } else if (item.type === 'function_call_output' && !seen.has(item.call_id)) {
          throw new Error(`tool call result has no matching tool call: ${item.call_id}`)
        }
      }
      input.push(item)
    }
  }
  return {
    model: request.model,
    input,
    tools: parsed.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false
    }))
  }
}
