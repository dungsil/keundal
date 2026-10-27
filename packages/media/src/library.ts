import type { ExecutionOptions } from '@keundal/core'
import { Service, type Context } from 'cordis'

/** 자료库 폴더 하나를 가리키는 값입니다. */
export interface MediaLibrary {
  readonly path: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 영상 파일을 자료库 안에 복사했는지, 원본 경로를 연결했는지 나타냅니다. */
export type MediaItemStorage = 'copy' | 'link'

/** 영상이 어디에서 들어왔는지 나타냅니다. */
export type MediaItemOrigin =
  | { readonly kind: 'downloaded'; readonly url: string }
  | { readonly kind: 'local'; readonly path: string }

export interface MediaItemVideo {
  /** 자료库 기준 상대 경로입니다. 연결 항목은 절대 경로를 담습니다. */
  readonly path: string
  /** 파일 존재 여부를 마지막으로 확인한 결과입니다. */
  readonly present: boolean
}

export interface SubtitleSegment {
  readonly startMs: number
  readonly endMs: number
  readonly text: string
  readonly speaker: string | null
}

export interface SubtitleTrack {
  readonly id: string
  readonly kind: 'original' | 'translation'
  readonly language: string
  readonly segments: readonly SubtitleSegment[]
}

export interface MediaItem {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly storage: MediaItemStorage
  readonly origin: MediaItemOrigin
  readonly video: MediaItemVideo
  readonly subtitleTracks: readonly SubtitleTrack[]
}

export interface CreateLibraryRequest {
  readonly path: string
  readonly name?: string
}

export interface OpenLibraryRequest {
  readonly path: string
}

export interface ImportMediaEntry {
  readonly filePath: string
  readonly storage: MediaItemStorage
  readonly title?: string
}

export interface ImportMediaRequest {
  readonly libraryPath: string
  readonly entries: readonly ImportMediaEntry[]
}

export interface RemoveMediaRequest {
  readonly libraryPath: string
  readonly itemId: string
  /** 참이면 되돌릴 수 없는 삭제를 수행합니다. */
  readonly permanent?: boolean
}

export interface RelocateMediaRequest {
  readonly libraryPath: string
  readonly itemId: string
  readonly filePath: string
}

export interface SaveSubtitleRequest {
  readonly libraryPath: string
  readonly itemId: string
  readonly track: SubtitleTrack
}

declare module 'cordis' {
  interface Context {
    readonly media: MediaLibraryService
  }
}

/**
 * 자료库 폴더와 그 안의 항목을 읽고 씁니다.
 * 파일 시스템 접근은 구현 플러그인이 담당하며, 이 계약은 경로와 항목 값만 다룹니다.
 */
export abstract class MediaLibraryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'media')
  }

  abstract create(request: CreateLibraryRequest, options?: ExecutionOptions): Promise<MediaLibrary>

  abstract open(request: OpenLibraryRequest, options?: ExecutionOptions): Promise<MediaLibrary>

  abstract list(libraryPath: string, options?: ExecutionOptions): Promise<readonly MediaItem[]>

  abstract read(libraryPath: string, itemId: string, options?: ExecutionOptions): Promise<MediaItem>

  abstract import(request: ImportMediaRequest, options?: ExecutionOptions): Promise<readonly MediaItem[]>

  abstract remove(request: RemoveMediaRequest, options?: ExecutionOptions): Promise<void>

  abstract relocate(request: RelocateMediaRequest, options?: ExecutionOptions): Promise<MediaItem>

  abstract saveSubtitle(request: SaveSubtitleRequest, options?: ExecutionOptions): Promise<void>
}
