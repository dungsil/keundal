import type {
  RawContentBlockDelta,
  RawContentBlockStartEvent,
  RawMessageStreamEvent,
  StopReason
} from '@anthropic-ai/sdk/resources/messages'
import { EventType, type LLMEvent } from '@keundal/core'

type Item =
  | { type: 'text'; id: string }
  | { type: 'tool_use'; id: string; arguments: string; initialInput: Record<string, unknown>; hostMessageId?: string }
  | { type: 'thinking'; id: string; signature: string }
  | { type: 'redacted_thinking'; id: string; data: string }

export class MessageEvents {
  private readonly items = new Map<number, Item>()
  private readonly seenIndices = new Set<number>()
  private readonly seenToolIds = new Set<string>()
  private messageId?: string
  private stopReason?: StopReason
  private hasAssistantHost = false
  private lastBlockWasReasoning = false
  private finished = false;

  *convert(event: RawMessageStreamEvent): Generator<LLMEvent> {
    if (this.finished) throw new Error('Anthropic sent events after message_stop')
    if (event.type === 'message_start') {
      if (this.messageId) throw new Error('duplicate Anthropic message_start')
      if (!event.message.id) throw new Error('Anthropic message has no identifier')
      if (event.message.content.length) throw new Error('Anthropic message_start contains unexpected content')
      this.messageId = event.message.id
      return
    }
    if (!this.messageId) throw new Error('Anthropic event arrived before message_start')
    switch (event.type) {
      case 'content_block_start':
        if (this.stopReason) throw new Error('Anthropic content arrived after a stop reason')
        yield* this.begin(event)
        break
      case 'content_block_delta':
        yield* this.append(event.index, event.delta)
        break
      case 'content_block_stop':
        yield* this.close(event.index)
        break
      case 'message_delta': {
        const reason = event.delta.stop_reason
        if (!reason) break
        if (reason !== 'end_turn' && reason !== 'stop_sequence' && reason !== 'tool_use') {
          throw new Error(`Anthropic response finished with ${reason}`, { cause: event })
        }
        if (this.stopReason && this.stopReason !== reason) throw new Error('Anthropic stop reason changed')
        if (this.items.size) throw new Error('Anthropic response finished with unfinished content blocks')
        this.stopReason = reason
        break
      }
      case 'message_stop':
        if (!this.stopReason) throw new Error('Anthropic message_stop arrived without a stop reason')
        if (this.items.size) throw new Error('Anthropic response finished with unfinished content blocks')
        this.finished = true
        break
      default:
        throw new Error(`unsupported Anthropic stream event: ${(event as { type: string }).type}`)
    }
  }

  assertFinished(): void {
    if (!this.finished) throw new Error('Anthropic stream ended before message_stop')
    if (this.items.size) throw new Error('Anthropic response finished with unfinished content blocks')
  }

  private *begin(event: RawContentBlockStartEvent): Generator<LLMEvent> {
    if (!Number.isInteger(event.index) || event.index < 0 || this.seenIndices.has(event.index)) {
      throw new Error('invalid or duplicate Anthropic content block index')
    }
    if (this.items.size) throw new Error('Anthropic started a content block before the previous block finished')
    this.seenIndices.add(event.index)
    const block = event.content_block
    const id = `${this.messageId}-${event.index}`
    if (block.type === 'text') {
      if (block.citations?.length) throw new Error('unsupported Anthropic text citations')
      this.items.set(event.index, { type: 'text', id })
      this.hasAssistantHost = true
      this.lastBlockWasReasoning = false
      yield { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' }
      if (block.text) yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: block.text }
    } else if (block.type === 'tool_use') {
      if (!block.id || !block.name || this.seenToolIds.has(block.id))
        throw new Error('invalid or duplicate Anthropic tool call')
      if (typeof block.input !== 'object' || block.input === null || Array.isArray(block.input)) {
        throw new Error('Anthropic tool call input must be a JSON object')
      }
      this.seenToolIds.add(block.id)
      // MessageAssembly retains the last assistant host across reasoning blocks.
      const hostMessageId = this.hasAssistantHost && this.lastBlockWasReasoning ? id : undefined
      this.items.set(event.index, {
        type: 'tool_use',
        id: block.id,
        arguments: '',
        initialInput: block.input as Record<string, unknown>,
        hostMessageId
      })
      if (hostMessageId) {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: hostMessageId, role: 'assistant' }
      }
      this.hasAssistantHost = true
      this.lastBlockWasReasoning = false
      yield { type: EventType.TOOL_CALL_START, toolCallId: block.id, toolCallName: block.name }
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      this.lastBlockWasReasoning = true
      this.items.set(
        event.index,
        block.type === 'thinking'
          ? { type: 'thinking', id, signature: block.signature }
          : { type: 'redacted_thinking', id, data: block.data }
      )
      yield { type: EventType.REASONING_START, messageId: id }
      yield { type: EventType.REASONING_MESSAGE_START, messageId: id, role: 'reasoning' }
      if (block.type === 'thinking' && block.thinking) {
        yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: id, delta: block.thinking }
      }
    } else {
      throw new Error(`unsupported Anthropic output block: ${block.type}`)
    }
  }

  private *append(index: number, delta: RawContentBlockDelta): Generator<LLMEvent> {
    const item = this.items.get(index)
    if (!item) throw new Error('Anthropic delta has no matching content block')
    if (item.type === 'text' && delta.type === 'text_delta') {
      if (delta.text) yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: item.id, delta: delta.text }
    } else if (item.type === 'tool_use' && delta.type === 'input_json_delta') {
      if (Object.keys(item.initialInput).length)
        throw new Error('Anthropic tool call contains both initial input and JSON deltas')
      item.arguments += delta.partial_json
      if (delta.partial_json) yield { type: EventType.TOOL_CALL_ARGS, toolCallId: item.id, delta: delta.partial_json }
    } else if (item.type === 'thinking' && delta.type === 'thinking_delta') {
      if (delta.thinking) yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: item.id, delta: delta.thinking }
    } else if (item.type === 'thinking' && delta.type === 'signature_delta') {
      item.signature = delta.signature
    } else {
      throw new Error(`unsupported Anthropic delta ${delta.type} for ${item.type}`)
    }
  }

  private *close(index: number): Generator<LLMEvent> {
    const item = this.items.get(index)
    if (!item) throw new Error('Anthropic completion has no matching content block')
    if (item.type === 'text') {
      yield { type: EventType.TEXT_MESSAGE_END, messageId: item.id }
    } else if (item.type === 'tool_use') {
      if (item.arguments) {
        let parsed: unknown
        try {
          parsed = JSON.parse(item.arguments)
        } catch (error) {
          throw new Error('Anthropic tool call arguments must be a JSON object', { cause: error })
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('Anthropic tool call arguments must be a JSON object')
        }
      } else {
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: item.id, delta: JSON.stringify(item.initialInput) }
      }
      yield { type: EventType.TOOL_CALL_END, toolCallId: item.id }
      if (item.hostMessageId) yield { type: EventType.TEXT_MESSAGE_END, messageId: item.hostMessageId }
    } else {
      if (item.type === 'thinking' && !item.signature) throw new Error('Anthropic thinking block has no signature')
      if (item.type === 'redacted_thinking' && !item.data)
        throw new Error('Anthropic redacted thinking block has no data')
      yield {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: 'message',
        entityId: item.id,
        encryptedValue: JSON.stringify(
          item.type === 'thinking'
            ? { provider: 'anthropic', type: 'thinking', signature: item.signature }
            : { provider: 'anthropic', type: 'redacted_thinking', data: item.data }
        )
      }
      yield { type: EventType.REASONING_MESSAGE_END, messageId: item.id }
      yield { type: EventType.REASONING_END, messageId: item.id }
    }
    this.items.delete(index)
  }
}
