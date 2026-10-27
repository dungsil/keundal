import type { Context } from 'cordis'

import { WhisperTranscriptionService, type WhisperConfig } from './service.js'

export * from './lines.js'
export * from './models.js'
export * from './service.js'
export * from './whisper.js'

export const whisperTranscriptionPlugin = Object.assign(
  function whisperTranscriptionPlugin(ctx: Context, config: WhisperConfig) {
    new WhisperTranscriptionService(ctx, config)
  },
  { inject: ['shell', 'mediaTools'] }
)

export default whisperTranscriptionPlugin
