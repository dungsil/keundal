import { EventType, type LLMEvent } from '@keundal/core'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'

type Item = { type: 'message' | 'function_call' | 'reasoning'; text: string; callId?: string }

export class ResponseEvents {
  private readonly items = new Map<string, Item>();

  *convert(event: ResponseStreamEvent): Generator<LLMEvent> {
    switch (event.type) {
      case 'response.output_item.added': {
        const item = event.item
        if (!item.id) throw new Error('OpenAI output item has no identifier')
        if (this.items.has(item.id)) throw new Error('duplicate OpenAI output item')
        if (item.type === 'message') {
          this.items.set(item.id, { type: item.type, text: '' })
          yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId: item.id,
            role: 'assistant',
            ...(item.phase ? { metadata: { 'openai.phase': item.phase } } : {})
          }
        } else if (item.type === 'function_call') {
          this.items.set(item.id, { type: item.type, callId: item.call_id, text: '' })
          yield { type: EventType.TOOL_CALL_START, toolCallId: item.call_id, toolCallName: item.name }
          yield* this.append(item.id, item.arguments, 'function_call')
        } else if (item.type === 'reasoning') {
          this.items.set(item.id, { type: item.type, text: '' })
          yield { type: EventType.REASONING_START, messageId: item.id }
          yield { type: EventType.REASONING_MESSAGE_START, messageId: item.id, role: 'reasoning' }
        } else {
          throw new Error(`unsupported OpenAI output item: ${item.type}`)
        }
        break
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        yield* this.append(event.item_id, event.delta, 'message')
        break
      case 'response.function_call_arguments.delta':
        yield* this.append(event.item_id, event.delta, 'function_call')
        break
      case 'response.reasoning_summary_text.delta':
        yield* this.append(event.item_id, event.delta, 'reasoning')
        break
      case 'response.output_item.done': {
        const item = event.item
        if (!item.id) throw new Error('OpenAI output item has no identifier')
        const tracked = this.items.get(item.id)
        if (!tracked || tracked.type !== item.type) throw new Error('unexpected OpenAI output item completion')
        if (item.type === 'message') {
          yield* this.finishText(
            item.id,
            item.content.map((part) => (part.type === 'output_text' ? part.text : part.refusal)).join('')
          )
          yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId: item.id,
            ...(item.phase ? { metadata: { 'openai.phase': item.phase } } : {})
          }
        } else if (item.type === 'function_call') {
          if (item.call_id !== tracked.callId) throw new Error('OpenAI tool call identity changed')
          yield* this.finishText(item.id, item.arguments)
          yield { type: EventType.TOOL_CALL_END, toolCallId: item.call_id }
        } else if (item.type === 'reasoning') {
          yield* this.finishText(item.id, item.summary.map((part) => part.text).join(''))
          if (item.encrypted_content) {
            yield {
              type: EventType.REASONING_ENCRYPTED_VALUE,
              subtype: 'message',
              entityId: item.id,
              encryptedValue: item.encrypted_content
            }
          }
          yield { type: EventType.REASONING_MESSAGE_END, messageId: item.id }
          yield { type: EventType.REASONING_END, messageId: item.id }
        }
        this.items.delete(item.id)
        break
      }
    }
  }

  assertFinished(): void {
    if (this.items.size) throw new Error('OpenAI response completed with unfinished output items')
  }

  *finish(): Generator<LLMEvent> {
    for (const item of this.items.values()) {
      if (item.type === 'function_call') throw new Error('OpenAI stream ended with unfinished tool calls')
    }
    for (const [id, item] of this.items) {
      if (item.type === 'message') {
        yield { type: EventType.TEXT_MESSAGE_END, messageId: id }
      } else {
        yield { type: EventType.REASONING_MESSAGE_END, messageId: id }
        yield { type: EventType.REASONING_END, messageId: id }
      }
    }
    this.items.clear()
  }

  private *append(id: string, delta: string, type: Item['type']): Generator<LLMEvent> {
    const item = this.items.get(id)
    if (!item || item.type !== type) throw new Error('OpenAI delta has no matching output item')
    if (!delta) return
    item.text += delta
    if (item.type === 'message') yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta }
    else if (item.type === 'reasoning') yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: id, delta }
    else yield { type: EventType.TOOL_CALL_ARGS, toolCallId: item.callId!, delta }
  }

  private *finishText(id: string, text: string): Generator<LLMEvent> {
    const item = this.items.get(id)!
    if (!text.startsWith(item.text)) throw new Error('OpenAI final content differs from streamed content')
    yield* this.append(id, text.slice(item.text.length), item.type)
  }
}
