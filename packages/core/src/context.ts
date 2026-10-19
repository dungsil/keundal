import type { Context } from 'cordis'

import type { FileSystemService } from './fs.js'
import type { GenerationService } from './generation.js'
import type { LLMService } from './llm.js'
import type { SessionService } from './session.js'
import type { ShellService } from './shell.js'
import type { SkillService } from './skill.js'
import type { TranscriptionService } from './transcription.js'

declare module 'cordis' {
  interface Context {
    readonly fs: FileSystemService
    readonly shell: ShellService
    readonly transcription: TranscriptionService
    readonly llm: LLMService
    readonly generation: GenerationService
    readonly session: SessionService
    readonly skills: SkillService
  }
}

export interface KeundalContext extends Context {}
