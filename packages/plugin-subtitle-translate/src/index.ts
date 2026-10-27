import type { Context } from 'cordis'

import { LlmSubtitleTranslationService, type SubtitleTranslateConfig } from './service.js'

export * from './parse.js'
export * from './service.js'

export const subtitleTranslatePlugin = Object.assign(
  function subtitleTranslatePlugin(ctx: Context, config: SubtitleTranslateConfig = {}) {
    new LlmSubtitleTranslationService(ctx, config)
  },
  { inject: ['llm'] }
)

export default subtitleTranslatePlugin
