import { resolveModel, type ModelOption } from '@keundal/chat/models'
import { type ExecutionOptions } from '@keundal/core'
import { LLMService, type LLMRequest, type LLMEvent } from '@keundal/llm'
import { providerCredentials, providerError, type LLMSettings } from '@keundal/llm-settings'
import { Context, type Fiber } from 'cordis'

export const metadata = {
  name: { en: 'Browser model connection', ko: '브라우저 모델 연결' },
  description: {
    en: 'Calls the configured model providers directly from this browser.',
    ko: '이 브라우저에서 설정한 모델 공급자에 직접 요청합니다.'
  }
}

const plugins = {
  openai: () => import('@keundal/plugin-llm-openai').then((module) => module.default),
  'openai-chat': () => import('@keundal/plugin-llm-openai-chat').then((module) => module.default),
  anthropic: () => import('@keundal/plugin-llm-anthropic').then((module) => module.default),
  google: () => import('@keundal/plugin-llm-gemini').then((module) => module.default)
}

/** Resolves browser-owned settings at call time; credentials never enter generation requests. */
export function browserLLMPlugin(
  ctx: Context,
  config: { getSettings: () => LLMSettings; getModels?: () => ModelOption[] }
) {
  const active = new Set<Fiber>()
  let disposed = false
  ctx.fiber.effect(() => async () => {
    disposed = true
    await Promise.all([...active].map((fiber) => fiber.dispose()))
  })

  async function open(model: string, options?: ExecutionOptions) {
    const { provider, configuration, id, value } = resolveModel(model)
    const credentials = providerCredentials(config.getSettings(), configuration)
    const metadata = config.getModels?.().find((item) => item.value === value)
    const plugin = await plugins[provider]()
    options?.signal?.throwIfAborted()
    if (disposed) throw new Error('Browser LLM service is disposed')
    const context = new Context()
    const fiber = context.plugin(plugin, {
      ...credentials,
      dangerouslyAllowBrowser: true,
      // App budgets are upper bounds, not advertised limits for APIs without model metadata.
      models: {
        [id]: {
          contextWindow: Math.min(128_000, metadata?.contextWindow ?? 128_000),
          maxOutputTokens: Math.min(4096, metadata?.maxOutputTokens ?? 4096, (metadata?.contextWindow ?? 128_000) - 1),
          capabilities: metadata?.capabilities
        }
      }
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
      throw providerError(provider, error, credentials)
    }
    return { llm: context.llm, provider, id, dispose, credentials }
  }

  class BrowserLLM extends LLMService {
    async getModel(model: string, options?: ExecutionOptions) {
      options?.signal?.throwIfAborted()
      const service = await open(model, options)
      try {
        return await service.llm.getModel(service.id, options)
      } finally {
        await service.dispose()
      }
    }

    async countTokens(request: LLMRequest, options?: ExecutionOptions) {
      options?.signal?.throwIfAborted()
      const service = await open(request.model, options)
      try {
        return await service.llm.countTokens({ ...request, model: service.id }, options)
      } catch (error) {
        options?.signal?.throwIfAborted()
        throw providerError(service.provider, error, service.credentials)
      } finally {
        await service.dispose()
      }
    }

    async *stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterable<LLMEvent> {
      options?.signal?.throwIfAborted()
      const service = await open(request.model, options)
      try {
        yield* service.llm.stream({ ...request, model: service.id }, options)
      } catch (error) {
        options?.signal?.throwIfAborted()
        throw providerError(service.provider, error, service.credentials)
      } finally {
        await service.dispose()
      }
    }
  }
  new BrowserLLM(ctx)
}
