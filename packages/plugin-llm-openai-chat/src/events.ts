import { EventType, type LLMEvent } from '@keundal/core'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'

type ToolCall = { id: string; name: string; arguments: string }

export class CompletionEvents {
  private messageId?: string
  private textOpen = false
  private readonly toolCalls = new Map<number, ToolCall>()
  // 세미콜론이 없으면 다음 줄의 생성자 메서드가 곱셈으로 해석됩니다.
  private finished = false;

  *convert(chunk: ChatCompletionChunk): Generator<LLMEvent> {
    if (!chunk.id) throw new Error('OpenAI Chat Completions chunk has no identifier')
    if (this.messageId === undefined) this.messageId = chunk.id
    else if (this.messageId !== chunk.id) throw new Error('OpenAI Chat Completions changed the completion identifier')
    // 사용량을 담은 마지막 청크는 선택지가 없으므로 응답이 끝난 뒤에도 도착합니다.
    if (this.finished) {
      if (chunk.choices.length) throw new Error('OpenAI Chat Completions sent a chunk after the response finished')
      return
    }
    for (const choice of chunk.choices) {
      if (choice.index !== 0) throw new Error('OpenAI Chat Completions returned more than one choice')
      yield* this.append(choice)
    }
  }

  /** EOF에 도달했을 때 아직 열린 항목을 종료합니다. */
  *close(): Generator<LLMEvent> {
    if (this.toolCalls.size) throw new Error('OpenAI Chat Completions stream ended with unfinished tool calls')
    if (this.textOpen) {
      this.textOpen = false
      yield { type: EventType.TEXT_MESSAGE_END, messageId: this.messageId! }
    }
  }

  private *append(choice: ChatCompletionChunk.Choice): Generator<LLMEvent> {
    const delta = choice.delta
    if (delta.role !== undefined && delta.role !== 'assistant') {
      throw new Error(`unsupported OpenAI Chat Completions role: ${delta.role}`)
    }
    // 더 이상 쓰이지 않는 단일 함수 호출 형식은 조용히 버리지 않고 알립니다.
    if (delta.function_call) throw new Error('OpenAI Chat Completions deprecated function calls are not supported')
    const text = delta.content ?? delta.refusal ?? ''
    if (text) {
      if (!this.textOpen) {
        this.textOpen = true
        yield { type: EventType.TEXT_MESSAGE_START, messageId: this.messageId!, role: 'assistant' }
      }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: this.messageId!, delta: text }
    }
    for (const call of delta.tool_calls ?? []) {
      yield* this.appendToolCall(call)
    }
    if (choice.finish_reason) yield* this.finish(choice.finish_reason)
  }

  private *appendToolCall(call: ChatCompletionChunk.Choice.Delta.ToolCall): Generator<LLMEvent> {
    const existing = this.toolCalls.get(call.index)
    if (existing) {
      if (call.id && call.id !== existing.id) {
        throw new Error('OpenAI Chat Completions changed the tool call identifier')
      }
      if (call.function?.name && call.function.name !== existing.name) {
        throw new Error('OpenAI Chat Completions changed the tool call name')
      }
      const args = call.function?.arguments ?? ''
      if (args) {
        existing.arguments += args
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: existing.id, delta: args }
      }
      return
    }
    if (!call.id || !call.function?.name) {
      throw new Error('OpenAI Chat Completions tool call has no identifier or name')
    }
    this.toolCalls.set(call.index, { id: call.id, name: call.function.name, arguments: '' })
    yield {
      type: EventType.TOOL_CALL_START,
      toolCallId: call.id,
      toolCallName: call.function.name,
      parentMessageId: this.messageId
    }
    const args = call.function.arguments ?? ''
    if (args) {
      this.toolCalls.get(call.index)!.arguments += args
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: args }
    }
  }

  private *finish(reason: NonNullable<ChatCompletionChunk.Choice['finish_reason']>): Generator<LLMEvent> {
    if (this.finished) throw new Error('OpenAI Chat Completions finished more than once')
    if (reason === 'length') throw new Error('OpenAI Chat Completions response incomplete: length')
    if (reason === 'content_filter')
      throw new Error('OpenAI Chat Completions response was filtered by the content policy')
    for (const call of this.toolCalls.values()) {
      yield { type: EventType.TOOL_CALL_END, toolCallId: call.id }
    }
    this.toolCalls.clear()
    if (this.textOpen) {
      this.textOpen = false
      yield { type: EventType.TEXT_MESSAGE_END, messageId: this.messageId! }
    }
    this.finished = true
  }
}
