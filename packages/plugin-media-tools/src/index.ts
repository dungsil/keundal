import type { Context } from 'cordis'

import { LocalMediaToolsService, type MediaToolsConfig } from './service.js'

export * from './service.js'

export const localMediaToolsPlugin = Object.assign(
  function localMediaToolsPlugin(ctx: Context, config: MediaToolsConfig) {
    new LocalMediaToolsService(ctx, config)
  },
  { inject: ['shell'] }
)

export default localMediaToolsPlugin
