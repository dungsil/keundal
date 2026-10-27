import type { Context } from 'cordis'

import { LocalMediaExportService, type MediaExportConfig } from './service.js'

export * from './ass.js'
export * from './fcpxml.js'
export * from './service.js'

export const localMediaExportPlugin = Object.assign(
  function localMediaExportPlugin(ctx: Context, config: MediaExportConfig = {}) {
    new LocalMediaExportService(ctx, config)
  },
  { inject: ['shell', 'mediaTools', 'media'] }
)

export default localMediaExportPlugin
