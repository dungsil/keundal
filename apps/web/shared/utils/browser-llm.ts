import { LLMService, type LLMRequest, type ExecutionOptions, type LLMEvent } from '@keundal/core'
import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import anthropicLLMPlugin from '@keundal/plugin-llm-anthropic'
import geminiLLMPlugin from '@keundal/plugin-llm-gemini'
import { Context, type Fiber } from 'cordis'
import { LLM_PROVIDERS, providerCredentials, providerError, type LLMSettings } from './llm-settings'

const plugins = { openai: openaiLLMPlugin, anthropic: anthropicLLMPlugin, google: geminiLLMPlugin }

/** Resolves browser-owned settings at call time; credentials never enter generation requests. */
export function browserLLMPlugin(ctx: Context, config: { getSettings: () => LLMSettings }) {
  const active = new Set<Fiber>()
  ctx.fiber.effect(() => async () => {
    await Promise.all([...active].map(fiber => fiber.dispose()))
  })

  async function open(model: string) {
    const provider = LLM_PROVIDERS.find(item => item.model === model)
    if (!provider) throw new Error('Unknown chat model')
    const credentials = providerCredentials(config.getSettings(), provider.id)
    const context = new Context()
    const fiber = context.plugin(plugins[provider.id], {
      ...credentials,
      dangerouslyAllowBrowser: true,
      models: { [model]: { contextWindow: 128_000, maxOutputTokens: 4096 } }
    })
    active.add(fiber)
    const dispose = async () => {
      await fiber.dispose()
      active.delete(fiber)
    }
    try {
      await fiber
    } catch (error) {
      await dispose()
      throw providerError(provider.id, error)
    }
    return { llm: context.llm, provider: provider.id, dispose }
  }

  class BrowserLLM extends LLMService {
    async getModel(model: string, options?: ExecutionOptions) {
      options?.signal?.throwIfAborted()
      const service = await open(model)
      try {
        return await service.llm.getModel(model, options)
      } finally {
        await service.dispose()
      }
    }

    async countTokens(request: LLMRequest, options?: ExecutionOptions) {
      options?.signal?.throwIfAborted()
      const service = await open(request.model)
      try {
        return await service.llm.countTokens(request, options)
      } catch (error) {
        options?.signal?.throwIfAborted()
        throw providerError(service.provider, error)
      } finally {
        await service.dispose()
      }
    }

    async* stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterable<LLMEvent> {
      options?.signal?.throwIfAborted()
      const service = await open(request.model)
      try {
        yield* service.llm.stream(request, options)
      } catch (error) {
        options?.signal?.throwIfAborted()
        throw providerError(service.provider, error)
      } finally {
        await service.dispose()
      }
    }
  }
  new BrowserLLM(ctx)
}
