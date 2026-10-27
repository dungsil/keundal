import type { ExecutionOptions } from '@keundal/core'
import { Service, type Context } from 'cordis'

/** 잘라 낼 구간 하나입니다. */
export interface MediaClip {
  readonly id: string
  readonly name: string
  readonly startMs: number
  readonly endMs: number
}

export interface ExportClipsRequest {
  readonly libraryPath: string
  readonly itemId: string
  readonly clips: readonly MediaClip[]
  /** 완성된 파일을 둘 디렉터리입니다. */
  readonly outputDirectory: string
  /** 참이면 `trackId`의 자막을 영상에 굽습니다. */
  readonly burnSubtitles?: boolean
  readonly trackId?: string
  /** 영상 위에 넣을 문자열입니다. 비우면 넣지 않습니다. */
  readonly watermark?: string | null
}

export interface MediaExportFile {
  readonly clipId: string
  readonly name: string
  readonly path: string
}

export interface ExportFcpxmlRequest {
  readonly libraryPath: string
  readonly itemId: string
  readonly clips: readonly MediaClip[]
  readonly outputPath: string
  readonly title?: string
}

export interface ExportFcpxmlResult {
  readonly path: string
  readonly clipCount: number
}

declare module 'cordis' {
  interface Context {
    readonly mediaExport: MediaExportService
  }
}

/**
 * 자료库 항목에서 클립을 만들고 편집기용 목록을 내보냅니다.
 * 프로세스 실행은 `ShellService`가 담당합니다.
 */
export abstract class MediaExportService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'mediaExport')
  }

  abstract clips(request: ExportClipsRequest, options?: ExecutionOptions): Promise<readonly MediaExportFile[]>

  abstract fcpxml(request: ExportFcpxmlRequest, options?: ExecutionOptions): Promise<ExportFcpxmlResult>
}
