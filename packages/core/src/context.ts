import type { Context } from 'cordis'

import type { CompactionService } from './compaction.js'
import type { GenerationService } from './generation.js'
import type { LLMService } from './llm.js'
import type { SessionService } from './session.js'

declare module 'cordis' {
  interface Context {
    readonly llm: LLMService
    readonly generation: GenerationService
    readonly session: SessionService
    readonly compaction: CompactionService
  }
}

export interface KeundalContext extends Context {}
