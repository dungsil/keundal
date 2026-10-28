import type { ChatPlatform } from '@keundal/chat/platform'
import { browserLLMPlugin as registerBrowserLLM } from '@keundal/plugin-llm-browser'
import { loadModels as discoverModels, type ModelLoaders } from '@keundal/plugin-llm-browser/models'
import type { Context } from 'cordis'

const providers = {
  openai: () => import('@keundal/plugin-llm-openai').then((module) => module.default),
  'openai-chat': () => import('@keundal/plugin-llm-openai-chat').then((module) => module.default),
  anthropic: () => import('@keundal/plugin-llm-anthropic').then((module) => module.default),
  google: () => import('@keundal/plugin-llm-gemini').then((module) => module.default)
}

const modelLoaders: ModelLoaders = {
  openai: () => import('@keundal/plugin-llm-openai').then((module) => module.listOpenAIModels),
  'openai-chat': () => import('@keundal/plugin-llm-openai-chat').then((module) => module.listOpenAIChatModels),
  anthropic: () => import('@keundal/plugin-llm-anthropic').then((module) => module.listAnthropicModels),
  google: () => import('@keundal/plugin-llm-gemini').then((module) => module.listGeminiModels)
}

/** Default application wiring; consumers can register the browser adapter with other providers. */
export function browserLLMPlugin(ctx: Context, config: Omit<Parameters<typeof registerBrowserLLM>[1], 'providers'>) {
  registerBrowserLLM(ctx, { ...config, providers })
}

export const loadModels: ChatPlatform['loadModels'] = (...args) => discoverModels(modelLoaders, ...args)
