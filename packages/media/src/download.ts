import type { ExecutionOptions } from '@keundal/core'
import { Service, type Context } from 'cordis'

export type MediaDownloadState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

/** 내려받을 화질입니다. `audio`는 음원만 저장합니다. */
export type MediaDownloadFormat = 'best' | '1080p' | '720p' | 'audio'

/** 영상에 딸린 자막을 함께 받을지 정합니다. */
export type MediaSubtitlePolicy = 'none' | 'builtin'

export interface MediaDownloadRequest {
  readonly url: string
  /** 완성된 파일을 둘 디렉터리입니다. */
  readonly outputDirectory: string
  readonly format?: MediaDownloadFormat
  readonly subtitles?: MediaSubtitlePolicy
  /** 로그인이 필요한 영상에서 쓸 브라우저 이름입니다. 예를 들어 `chrome`입니다. */
  readonly cookiesFromBrowser?: string | null
}

export interface MediaDownloadProgress {
  readonly jobId: string
  readonly state: MediaDownloadState
  readonly percent: number | null
  readonly downloadedBytes: number | null
  readonly totalBytes: number | null
  readonly speedBytesPerSecond: number | null
  readonly etaSeconds: number | null
  /** 실패 사유나 진행 안내 문구입니다. */
  readonly message: string | null
}

export interface MediaDownloadJob extends MediaDownloadProgress {
  readonly url: string
  readonly title: string | null
  readonly filePath: string | null
}

export interface MediaDownloadSubscriptionOptions extends ExecutionOptions {
  /** 이미 끝난 작업의 기록도 먼저 전달받습니다. */
  readonly replay?: boolean
}

declare module 'cordis' {
  interface Context {
    readonly mediaDownload: MediaDownloadService
  }
}

/**
 * 링크 하나를 영상 파일로 내려받는 작업 큐입니다.
 * 작업 상태는 `subscribe`로 전달하고, `wait`는 작업이 끝날 때까지 기다립니다.
 */
export abstract class MediaDownloadService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mediaDownload')
  }

  /** 작업을 큐에 넣고 즉시 반환합니다. 실행은 백그라운드에서 이어집니다. */
  abstract start(request: MediaDownloadRequest, options?: ExecutionOptions): Promise<MediaDownloadJob>

  abstract pause(jobId: string, options?: ExecutionOptions): Promise<void>

  /** 중단한 지점부터 다시 받습니다. 구현이 이어받기를 지원하지 않으면 처음부터 받습니다. */
  abstract resume(jobId: string, options?: ExecutionOptions): Promise<MediaDownloadJob>

  abstract cancel(jobId: string, options?: ExecutionOptions): Promise<void>

  abstract list(): readonly MediaDownloadJob[]

  /** 작업이 끝나거나 실패할 때까지 기다립니다. */
  abstract wait(jobId: string, options?: ExecutionOptions): Promise<MediaDownloadJob>

  abstract subscribe(
    listener: (progress: MediaDownloadProgress) => void,
    options?: MediaDownloadSubscriptionOptions
  ): () => void
}
