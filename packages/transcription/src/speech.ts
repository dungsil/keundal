import type { ExecutionOptions } from '@keundal/core'
import { Service, type Context } from 'cordis'

/** 로컬에서 실행하는 음성 인식 모델입니다. */
export interface SpeechModel {
  readonly id: string
  /** 사람이 읽는 이름입니다. */
  readonly label: string
  readonly url: string
  /** 내려받을 파일의 대략적인 바이트 수입니다. */
  readonly bytes: number
}

export interface SpeechModelStatus extends SpeechModel {
  readonly installed: boolean
  readonly path: string | null
}

export interface SpeechModelProgress {
  readonly id: string
  readonly downloadedBytes: number
  readonly totalBytes: number | null
}

export interface SpeechModelOptions extends ExecutionOptions {
  readonly onProgress?: (progress: SpeechModelProgress) => void
}

/** 단어 하나와 그 발화 구간입니다. 자막 줄 나누기에 사용합니다. */
export interface SpeechWord {
  readonly text: string
  readonly startMs: number
  readonly endMs: number
}

export interface TranscribedSegment {
  readonly startMs: number
  readonly endMs: number
  readonly text: string
}

export interface TranscribeMediaRequest {
  /** 전사할 미디어 파일의 절대 경로입니다. */
  readonly filePath: string
  /** 비우면 모델이 언어를 감지합니다. */
  readonly language?: string | null
  readonly model?: string
}

export interface TranscribeMediaResult {
  readonly model: string
  /** 감지했거나 지정한 언어 코드입니다. 알 수 없으면 null입니다. */
  readonly language: string | null
  /** 인식기가 돌려준 구간입니다. 길이를 다듬지 않은 원본입니다. */
  readonly segments: readonly TranscribedSegment[]
  /** 단어 단위 시각입니다. 인식기가 제공하지 않으면 빈 배열입니다. */
  readonly words: readonly SpeechWord[]
}

declare module 'cordis' {
  interface Context {
    readonly mediaTranscription: MediaTranscriptionService
  }
}

/**
 * 저장된 미디어 파일을 자막으로 바꾸는 계약입니다.
 * 브라우저 실시간 받아쓰기와 달리 파일 전체를 한 번에 처리합니다.
 */
export abstract class MediaTranscriptionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mediaTranscription')
  }

  abstract models(options?: ExecutionOptions): Promise<readonly SpeechModelStatus[]>

  abstract installModel(request: { readonly id: string }, options?: SpeechModelOptions): Promise<SpeechModelStatus>

  abstract transcribe(request: TranscribeMediaRequest, options?: ExecutionOptions): Promise<TranscribeMediaResult>
}
