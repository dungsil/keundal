import type { Context } from 'cordis'

import { LocalMediaDownloadService, type MediaDownloadConfig } from './service.js'

export * from './service.js'

export const localMediaDownloadPlugin = Object.assign(
  function localMediaDownloadPlugin(ctx: Context, config: MediaDownloadConfig = {}) {
    new LocalMediaDownloadService(ctx, config)
  },
  { inject: ['shell', 'mediaTools'] }
)

export default localMediaDownloadPlugin
