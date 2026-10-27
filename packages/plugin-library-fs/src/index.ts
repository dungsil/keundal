import type { Context } from 'cordis'

import { FsMediaLibraryService, type FsMediaLibraryConfig } from './service.js'

export * from './service.js'

export function fsMediaLibraryPlugin(ctx: Context, config: FsMediaLibraryConfig = {}): void {
  new FsMediaLibraryService(ctx, config)
}

export default fsMediaLibraryPlugin
