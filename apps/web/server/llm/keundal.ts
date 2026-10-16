import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider'
import { EventType, type AgentMessage, type LLMService } from '@keundal/core'
import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import anthropicLLMPlugin from '@keundal/plugin-llm-anthropic'
import geminiLLMPlugin from '@keundal/plugin-llm-gemini'
import { Context } from 'cordis'

const models = {
  'openai/gpt-5-nano': { plugin: openaiLLMPlugin, id: 'gpt-5-nano', provider: 'openai', key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL' },
  'anthropic/claude-haiku-4.5': { plugin: anthropicLLMPlugin, id: 'claude-haiku-4-5', provider: 'anthropic', key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL' },
  'google/gemini-3-flash': { plugin: geminiLLMPlugin, id: 'gemini-3-flash-preview', provider: 'google', key: 'GEMINI_API_KEY', url: 'GEMINI_BASE_URL' }
}

// Keundal does not report token usage; unknown is not zero.
const usage: LanguageModelV4Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined }
}

function toMessages(prompt: LanguageModelV4CallOptions['prompt'], provider: string): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (const message of prompt) {
    if (message.role === 'system') {
      messages.push({ id: randomUUID(), role: 'system', content: message.content })
      continue
    }
    if (message.role === 'user') {
      const content: Exclude<Extract<AgentMessage, { role: 'user' }>['content'], string> = []
      for (const part of message.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text })
        } else if (part.data.type === 'text') {
          content.push({ type: 'text', text: part.data.text })
        } else if (!part.mediaType.startsWith('image/')) {
          throw new Error(`Keundal does not support this attachment: ${part.mediaType}`)
        } else if (part.data.type === 'data') {
          content.push({ type: 'image', source: { type: 'data', mimeType: part.mediaType, value: typeof part.data.data === 'string' ? part.data.data : Buffer.from(part.data.data).toString('base64') } })
        } else if (part.data.type === 'url') {
          content.push({ type: 'image', source: { type: 'url', value: part.data.url.href, mimeType: part.mediaType } })
        } else {
          throw new Error('Keundal does not support provider file references in chat')
        }
      }
      messages.push({ id: randomUUID(), role: 'user', content })
      continue
    }
    for (const part of message.content) {
      const metadata = part.providerOptions?.keundal
      const sameProvider = metadata?.provider === provider
      const encryptedValue = sameProvider && typeof metadata?.encryptedValue === 'string' ? metadata.encryptedValue : undefined
      if (part.type === 'text') {
        messages.push({ id: randomUUID(), role: 'assistant', content: part.text })
      } else if (part.type === 'reasoning') {
        // Opaque provider state must never be replayed to a different provider.
        if (sameProvider) messages.push({ id: typeof metadata.id === 'string' ? metadata.id : randomUUID(), role: 'reasoning', content: part.text, encryptedValue })
      } else if (part.type === 'tool-call') {
        messages.push({ id: randomUUID(), role: 'assistant', toolCalls: [{ id: part.toolCallId, type: 'function', function: { name: part.toolName, arguments: JSON.stringify(part.input) }, ...(encryptedValue && { encryptedValue }) }] })
      } else if (part.type === 'tool-result') {
        const output = part.output
        if (output.type !== 'text' && output.type !== 'json' && output.type !== 'error-text' && output.type !== 'error-json') {
          throw new Error(`Keundal does not support this tool output: ${output.type}`)
        }
        messages.push({ id: randomUUID(), role: 'tool', toolCallId: part.toolCallId, content: typeof output.value === 'string' ? output.value : JSON.stringify(output.value) })
      } else {
        throw new Error(`Keundal does not support this message part: ${part.type}`)
      }
    }
  }
  return messages
}

function languageModel(llm: LLMService, modelId: string, provider: string): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: `keundal.${provider}`,
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const { stream } = await this.doStream(options)
      const content: LanguageModelV4Content[] = []
      const text = new Map<string, Extract<LanguageModelV4Content, { type: 'text' | 'reasoning' }>>()
      let finishReason: Awaited<ReturnType<LanguageModelV4['doGenerate']>>['finishReason'] = { unified: 'stop', raw: undefined }
      for await (const part of stream) {
        if (part.type === 'text-start' || part.type === 'reasoning-start') {
          const block = { type: part.type === 'text-start' ? 'text' as const : 'reasoning' as const, text: '' }
          text.set(part.id, block)
          content.push(block)
        } else if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
          text.get(part.id)!.text += part.delta
        } else if (part.type === 'reasoning-end') {
          text.get(part.id)!.providerMetadata = part.providerMetadata
        } else if (part.type === 'tool-call') {
          content.push(part)
        } else if (part.type === 'finish') {
          finishReason = part.finishReason
        } else if (part.type === 'error') {
          throw part.error
        }
      }
      return { content, finishReason, usage, warnings: [] }
    },
    async doStream(options) {
      const limits = await llm.getModel(modelId, { signal: options.abortSignal })
      const tools = (options.tools ?? []).map((tool) => {
        if (tool.type !== 'function') throw new Error('Keundal does not support provider-defined tools')
        return { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema }
      })
      const request = {
        model: modelId,
        maxOutputTokens: options.maxOutputTokens ?? limits.maxOutputTokens,
        input: { threadId: randomUUID(), runId: randomUUID(), state: {}, context: [], tools, messages: toMessages(options.prompt, provider) }
      }
      const controller = new AbortController()
      const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, controller.signal]) : controller.signal
      async function* chunks(): AsyncGenerator<LanguageModelV4StreamPart> {
        const calls = new Map<string, { name: string, input: string }>()
        const encrypted = new Map<string, string>()
        const metadata = (id: string) => ({ keundal: { provider, id, ...(encrypted.has(id) && { encryptedValue: encrypted.get(id)! }) } })
        yield { type: 'stream-start', warnings: [] }
        for await (const event of llm.stream(request, { signal })) {
          switch (event.type) {
            case EventType.TEXT_MESSAGE_START:
              yield { type: 'text-start', id: event.messageId }
              break
            case EventType.TEXT_MESSAGE_CONTENT:
              yield { type: 'text-delta', id: event.messageId, delta: event.delta }
              break
            case EventType.TEXT_MESSAGE_END:
              yield { type: 'text-end', id: event.messageId }
              break
            case EventType.REASONING_MESSAGE_START:
              yield { type: 'reasoning-start', id: event.messageId }
              break
            case EventType.REASONING_MESSAGE_CONTENT:
              yield { type: 'reasoning-delta', id: event.messageId, delta: event.delta }
              break
            case EventType.REASONING_ENCRYPTED_VALUE:
              encrypted.set(event.entityId, event.encryptedValue)
              break
            case EventType.REASONING_MESSAGE_END:
              yield { type: 'reasoning-end', id: event.messageId, providerMetadata: metadata(event.messageId) }
              break
            case EventType.TOOL_CALL_START:
              calls.set(event.toolCallId, { name: event.toolCallName, input: '' })
              yield { type: 'tool-input-start', id: event.toolCallId, toolName: event.toolCallName }
              break
            case EventType.TOOL_CALL_ARGS:
              calls.get(event.toolCallId)!.input += event.delta
              yield { type: 'tool-input-delta', id: event.toolCallId, delta: event.delta }
              break
            case EventType.TOOL_CALL_END: {
              const call = calls.get(event.toolCallId)!
              yield { type: 'tool-input-end', id: event.toolCallId }
              yield { type: 'tool-call', toolCallId: event.toolCallId, toolName: call.name, input: call.input, providerMetadata: metadata(event.toolCallId) }
              break
            }
          }
        }
        yield { type: 'finish', usage, finishReason: { unified: calls.size ? 'tool-calls' : 'stop', raw: undefined } }
      }
      const iterator = chunks()
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async pull(output) {
            try {
              const next = await iterator.next()
              if (next.done) output.close()
              else output.enqueue(next.value)
            } catch (error) {
              output.error(error)
            }
          },
          async cancel(reason) {
            controller.abort(reason)
            await iterator.return(undefined)
          }
        })
      }
    }
  }
}

/** Keep the template's model IDs while calling the existing Keundal provider plugins. */
export async function createKeundalModel(name: string, env: NodeJS.ProcessEnv = process.env) {
  if (!Object.hasOwn(models, name)) throw new Error(`Unknown chat model: ${name}`)
  const config = models[name as keyof typeof models]
  if (!env[config.key]) throw new Error(`Set ${config.key} to use ${name}`)
  const ctx = new Context()
  const fiber = await ctx.plugin(config.plugin, {
    apiKey: env[config.key],
    baseURL: env[config.url] || undefined,
    models: { [config.id]: { contextWindow: 128_000, maxOutputTokens: 4096 } }
  })
  return { model: languageModel(ctx.llm, config.id, config.provider), dispose: () => fiber.dispose() }
}
