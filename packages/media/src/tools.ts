import type { ExecutionOptions } from '@keundal/core'
import { Service, type Context } from 'cordis'

/** 자료库가 요구하는 외부 실행 파일 이름입니다. */
export type MediaToolName = 'yt-dlp' | 'ffmpeg'

/** 실행 파일을 찾은 경로의 종류입니다. */
export type MediaToolSource = 'configured' | 'installed' | 'system'

export interface MediaToolStatus {
  readonly name: MediaToolName
  readonly installed: boolean
  readonly path: string | null
  readonly version: string | null
  readonly source: MediaToolSource | null
}

export interface InstallMediaToolRequest {
  readonly name: MediaToolName
  /** 지정하면 해당 버전을 요청합니다. 구현이 버전 고정을 지원하지 않으면 무시합니다. */
  readonly version?: string
}

export interface MediaToolProgress {
  readonly name: MediaToolName
  readonly downloadedBytes: number
  readonly totalBytes: number | null
}

export interface MediaToolOptions extends ExecutionOptions {
  readonly onProgress?: (progress: MediaToolProgress) => void
}

export interface ConfigureMediaToolRequest {
  readonly name: MediaToolName
  /** null이면 직접 지정을 해제하고 기본 탐색 순서로 돌아갑니다. */
  readonly path: string | null
}

declare module 'cordis' {
  interface Context {
    readonly mediaTools: MediaToolsService
  }
}

/**
 * `yt-dlp`와 `ffmpeg` 실행 파일의 경로·버전·설치를 관리합니다.
 * 프로세스 실행은 `ShellService`가 담당하며, 이 계약은 상태와 설치 요청만 다룹니다.
 */
export abstract class MediaToolsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mediaTools')
  }

  abstract status(options?: ExecutionOptions): Promise<readonly MediaToolStatus[]>

  /** 실행 파일의 절대 경로를 반환하고, 찾지 못하면 예외를 던집니다. */
  abstract resolve(name: MediaToolName, options?: ExecutionOptions): Promise<string>

  abstract install(request: InstallMediaToolRequest, options?: MediaToolOptions): Promise<MediaToolStatus>

  abstract configure(request: ConfigureMediaToolRequest, options?: ExecutionOptions): Promise<void>
}
