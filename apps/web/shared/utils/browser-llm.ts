import { LLMService, type LLMRequest, type ExecutionOptions, type LLMEvent } from '@keundal/core'
import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import anthropicLLMPlugin from '@keundal/plugin-llm-anthropic'
import geminiLLMPlugin from '@keundal/plugin-llm-gemini'
import { Context, type Fiber } from 'cordis'
import { providerCredentials, providerError, type LLMSettings } from './llm-settings'
import { resolveModel, type ModelOption } from './models'

const plugins = { openai: openaiLLMPlugin, anthropic: anthropicLLMPlugin, google: geminiLLMPlugin }

/** Resolves browser-owned settings at call time; credentials never enter generation requests. */
export function browserLLMPlugin(ctx: Context, config: { getSettings: () => LLMSettings, getModels?: () => ModelOption[] }) {
  const active = new Set<Fiber>()
  ctx.fiber.effect(() => async () => {
    await Promise.all([...active].map(fiber => fiber.dispose()))
  })

  async function open(model: string) {
    const { provider, id, value } = resolveModel(model)
    const credentials = providerCredentials(config.getSettings(), provider)
    const metadata = config.getModels?.().find(item => item.value === value)
    const context = new Context()
    const fiber = context.plugin(plugins[provider], {
      ...credentials,
      dangerouslyAllowBrowser: true,
      // App budgets are upper bounds, not advertised limits for APIs without model metadata.
      models: { [id]: { contextWindow: Math.min(128_000, metadata?.contextWindow ?? 128_000), maxOutputTokens: Math.min(4096, metadata?.maxOutputTokens ?? 4096, (metadata?.contextWindow ?? 128_000) - 1) } }
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
      throw providerError(provider, error)
    }
    return { llm: context.llm, provider, id, dispose }
  }

  class BrowserLLM extends LLMService {
    async getModel(model: string, options?: ExecutionOptions) {
      options?.signal?.throwIfAborted()
      const service = await open(model)
      try {
        return await service.llm.getModel(service.id, options)
      } finally {
        await service.dispose()
      }
    }

    async countTokens(request: LLMRequest, options?: ExecutionOptions) {
      options?.signal?.throwIfAborted()
      const service = await open(request.model)
      try {
        return await service.llm.countTokens({ ...request, model: service.id }, options)
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
        yield* service.llm.stream({ ...request, model: service.id }, options)
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
