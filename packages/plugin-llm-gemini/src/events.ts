import { randomUUID } from 'node:crypto'

import { FinishReason } from '@google/genai'
import type { Candidate, GenerateContentResponse, Part } from '@google/genai'
import { EventType, type LLMEvent } from '@keundal/core'

type ItemKind = 'text' | 'thought'

interface Item {
  kind: ItemKind
  id: string
  text: string
  signature?: string
}

export class ContentsEvents {
  private open?: Item
  private finished = false
  private responseId?: string
  private idPrefix?: string
  private readonly counts = { text: 0, thought: 0, call: 0 };

  *convert(chunk: GenerateContentResponse): Generator<LLMEvent> {
    if (this.finished) throw new Error('Gemini sent chunks after the response finished')
    const blockReason = chunk.promptFeedback?.blockReason
    if (blockReason) throw new Error(`Gemini prompt was blocked: ${blockReason}`, { cause: chunk })
    this.trackResponseId(chunk.responseId)
    const candidates = chunk.candidates ?? []
    if (candidates.length > 1) throw new Error('Gemini sent multiple candidates in one chunk', { cause: chunk })
    const candidate: Candidate | undefined = candidates[0]
    if (!candidate) return
    if (candidate.index) throw new Error('Gemini sent a nonzero candidate index', { cause: chunk })
    for (const part of candidate.content?.parts ?? []) yield* this.convertPart(part)
    if (!candidate.finishReason) return
    if (candidate.finishReason !== FinishReason.STOP) {
      const detail = candidate.finishMessage ? `: ${candidate.finishMessage}` : ''
      throw new Error(`Gemini response finished with ${candidate.finishReason}${detail}`, { cause: candidate })
    }
    if (this.open) {
      yield* this.close(this.open)
      this.open = undefined
    }
    this.finished = true
  }

  assertFinished(): void {
    if (!this.finished) throw new Error('Gemini stream ended before a finish reason')
    if (this.open) throw new Error('Gemini response finished with an unfinished output item')
  }

  private *convertPart(part: Part): Generator<LLMEvent> {
    if (part.functionCall) {
      if (this.open) {
        yield* this.close(this.open)
        this.open = undefined
      }
      yield* this.convertFunctionCall(part)
      return
    }
    if (part.thought) {
      if (part.text === undefined && !part.thoughtSignature) {
        throw new Error(`unsupported Gemini output part: ${Object.keys(part).join(', ')}`)
      }
      if (this.open && this.open.kind !== 'thought') {
        yield* this.close(this.open)
        this.open = undefined
      }
      this.open ??= yield* this.begin('thought')
      if (part.thoughtSignature) {
        if (this.open.signature && this.open.signature !== part.thoughtSignature) {
          throw new Error('Gemini changed the thought signature of an output item', { cause: part })
        }
        this.open.signature = part.thoughtSignature
      }
      if (part.text) {
        this.open.text += part.text
        yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: this.open.id, delta: part.text }
      }
      return
    }
    if (part.text === undefined) {
      if (!part.thoughtSignature) {
        throw new Error(`unsupported Gemini output part: ${Object.keys(part).join(', ')}`)
      }
      return
    }
    if (this.open && this.open.kind !== 'text') {
      yield* this.close(this.open)
      this.open = undefined
    }
    this.open ??= yield* this.begin('text')
    if (part.text) {
      this.open.text += part.text
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: this.open.id, delta: part.text }
    }
  }

  private *convertFunctionCall(part: Part): Generator<LLMEvent> {
    const call = part.functionCall!
    if (call.partialArgs?.length || call.willContinue) {
      throw new Error('Gemini partial function calls are not supported', { cause: call })
    }
    if (!call.name) throw new Error('Gemini function call has no name', { cause: call })
    const toolCallId = call.id || `${this.prefix}-call-${this.counts.call++}`
    yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: call.name }
    yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(call.args ?? {}) }
    if (part.thoughtSignature) {
      yield {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: 'tool-call',
        entityId: toolCallId,
        encryptedValue: part.thoughtSignature
      }
    }
    yield { type: EventType.TOOL_CALL_END, toolCallId }
  }

  private *begin(kind: ItemKind): Generator<LLMEvent, Item> {
    if (kind === 'text') {
      const item: Item = { kind, id: `${this.prefix}-text-${this.counts.text++}`, text: '' }
      yield { type: EventType.TEXT_MESSAGE_START, messageId: item.id, role: 'assistant' }
      return item
    }
    const item: Item = { kind: 'thought', id: `${this.prefix}-thought-${this.counts.thought++}`, text: '' }
    yield { type: EventType.REASONING_START, messageId: item.id }
    yield { type: EventType.REASONING_MESSAGE_START, messageId: item.id, role: 'reasoning' }
    return item
  }

  private *close(item: Item): Generator<LLMEvent> {
    if (item.kind === 'text') {
      yield { type: EventType.TEXT_MESSAGE_END, messageId: item.id }
      return
    }
    if (item.signature) {
      yield {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: 'message',
        entityId: item.id,
        encryptedValue: item.signature
      }
    }
    yield { type: EventType.REASONING_MESSAGE_END, messageId: item.id }
    yield { type: EventType.REASONING_END, messageId: item.id }
  }

  private get prefix(): string {
    if (this.responseId) return this.responseId
    return (this.idPrefix ??= randomUUID())
  }

  private trackResponseId(value: string | undefined): void {
    if (!value) return
    if (this.responseId && this.responseId !== value) {
      throw new Error('Gemini response identifier changed mid-stream', { cause: value })
    }
    this.responseId = value
  }
}
