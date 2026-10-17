import { parseRunAgentInput } from '@keundal/core'
import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import anthropicLLMPlugin from '@keundal/plugin-llm-anthropic'
import geminiLLMPlugin from '@keundal/plugin-llm-gemini'
import { Context } from 'cordis'
import { z } from 'zod'

const providers = {
  'gpt-5-nano': { plugin: openaiLLMPlugin, key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL' },
  'claude-haiku-4-5': { plugin: anthropicLLMPlugin, key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL' },
  'gemini-3-flash-preview': { plugin: geminiLLMPlugin, key: 'GEMINI_API_KEY', url: 'GEMINI_BASE_URL' }
}

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, z.object({
    operation: z.enum(['model', 'count', 'stream']),
    model: z.enum(['gpt-5-nano', 'claude-haiku-4-5', 'gemini-3-flash-preview']),
    input: z.unknown().optional(),
    maxOutputTokens: z.number().int().min(1).max(4096).default(4096),
    webSearch: z.boolean().optional(), reasoning: z.boolean().optional()
  }).parse)
  const config = providers[body.model]
  if (!process.env[config.key]) throw createError({ statusCode: 503, statusMessage: `Set ${config.key} to use this model` })
  const ctx = new Context()
  const fiber = ctx.plugin(config.plugin, {
    apiKey: process.env[config.key]!, baseURL: process.env[config.url] || undefined,
    models: { [body.model]: { contextWindow: 128_000, maxOutputTokens: 4096 } }
  })
  const abort = new AbortController()
  const disconnected = () => abort.abort()
  event.node.res.once('close', disconnected)
  const dispose = async () => {
    event.node.res.removeListener('close', disconnected)
    await fiber.dispose()
  }
  try {
    await fiber
    if (body.operation === 'model') {
      const model = await ctx.llm.getModel(body.model, { signal: abort.signal })
      await dispose()
      return model
    }
    const request = { ...body, input: parseRunAgentInput(body.input) }
    if (body.operation === 'count') {
      const tokens = await ctx.llm.countTokens(request, { signal: abort.signal })
      await dispose()
      return { tokens }
    }
    let cancelled = false
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({
      async start(output) {
        try {
          for await (const item of ctx.llm.stream(request, { signal: abort.signal })) {
            if (!cancelled) output.enqueue(encoder.encode(`${JSON.stringify(item)}\n`))
          }
          if (!cancelled) output.enqueue(encoder.encode('{"done":true}\n'))
        } catch (error) {
          if (!cancelled) output.enqueue(encoder.encode(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`))
        } finally {
          if (!cancelled) output.close()
          await dispose()
        }
      },
      cancel() {
        cancelled = true
        abort.abort()
      }
    }), { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' } })
  } catch (error) {
    await dispose()
    throw error
  }
})
