import type { ExecutionOptions, Reasoning } from '@keundal/core'
import { Service, type Context } from 'cordis'

import type { SubtitleTrack } from './library.js'

/** 번역 요청에 함께 보낼 맥락의 범위입니다. */
export type TranslationContext = 'window' | 'full'

export interface TranslateSubtitlesRequest {
  /** 번역할 원본 트랙입니다. 시각과 화자 정보는 그대로 유지합니다. */
  readonly track: SubtitleTrack
  readonly targetLanguage: string
  readonly model: string
  /** 맥락으로 함께 보낼 영상 제목입니다. */
  readonly title?: string
  /** 번역 방식에 덧붙일 지시문입니다. */
  readonly prompt?: string
  /** 한 요청에 넣을 자막 구간 수입니다. */
  readonly batchSize?: number
  /** 동시에 보낼 요청 수입니다. */
  readonly concurrency?: number
  readonly context?: TranslationContext
  readonly reasoning?: Reasoning
}

export interface TranslateSubtitlesResult {
  readonly track: SubtitleTrack
  /** 번역에 실패해 원문을 남긴 구간 수입니다. */
  readonly failed: number
  /** 빈 구간이라 요청에서 뺀 수입니다. */
  readonly skipped: number
  /** 실제로 보낸 요청 수입니다. */
  readonly requests: number
}

declare module 'cordis' {
  interface Context {
    readonly subtitleTranslation: SubtitleTranslationService
  }
}

/**
 * 자막 트랙을 다른 언어로 번역합니다.
 * 구현은 `llm` 서비스만 사용하고 자체 HTTP 클라이언트를 만들지 않습니다.
 */
export abstract class SubtitleTranslationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subtitleTranslation')
  }

  abstract translate(request: TranslateSubtitlesRequest, options?: ExecutionOptions): Promise<TranslateSubtitlesResult>
}
