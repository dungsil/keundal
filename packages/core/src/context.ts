import type { Context } from 'cordis'

import type { GenerationService } from './generation.js'
import type { LLMService } from './llm.js'
import type { SessionService } from './session.js'
import type { TranscriptionService } from './transcription.js'

declare module 'cordis' {
  interface Context {
    readonly transcription: TranscriptionService
    readonly llm: LLMService
    readonly generation: GenerationService
    readonly session: SessionService
  }
}

export interface KeundalContext extends Context {}
