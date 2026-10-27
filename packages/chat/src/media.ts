import type {
  ExportClipsRequest,
  ExportFcpxmlRequest,
  ExportFcpxmlResult,
  ImportMediaEntry,
  MediaDownloadJob,
  MediaDownloadRequest,
  MediaExportFile,
  MediaItem,
  MediaLibrary,
  MediaToolName,
  MediaToolStatus,
  SubtitleTrack,
  TranslateSubtitlesRequest,
  TranslateSubtitlesResult
} from '@keundal/media'
import type { SpeechModelStatus, TranscribeMediaRequest, TranscribeMediaResult } from '@keundal/transcription'

import type { PlatformMedia } from './platform'

export interface MediaConnection {
  readonly endpoint: string
  readonly token: string
}

export interface HttpMediaClientOptions {
  /** 호출 시점에 호스트 주소와 토큰을 구합니다. 데스크톱은 sidecar를 먼저 띄워야 합니다. */
  readonly connection: () => Promise<MediaConnection>
  readonly request?: typeof globalThis.fetch
}

/**
 * 호스트의 `/media` 경로를 호출하는 플랫폼 클라이언트를 만듭니다.
 * 서비스가 없으면 호스트가 `503`을 돌려주고, 그 사유가 그대로 예외 메시지가 됩니다.
 */
export function createHttpMediaClient(options: HttpMediaClientOptions): PlatformMedia {
  const request = options.request ?? ((input, init) => globalThis.fetch(input, init))

  const call = async <T>(
    path: string,
    init: { readonly method?: string; readonly body?: unknown } = {}
  ): Promise<T> => {
    const connection = await options.connection()
    const headers = new Headers()
    if (connection.token) headers.set('authorization', `Bearer ${connection.token}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await request(`${connection.endpoint.replace(/\/+$/, '')}${path}`, {
      method: init.method ?? 'GET',
      headers,
      cache: 'no-store',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    })
    if (response.status === 204) return undefined as T
    const text = await response.text()
    const value: unknown = text.length > 0 ? JSON.parse(text) : {}
    if (!response.ok) {
      const message = (value as { error?: unknown }).error
      throw new Error(typeof message === 'string' ? message : `request failed: ${response.status}`)
    }
    return value as T
  }

  const itemPath = (request_: { libraryPath: string; itemId: string }) =>
    `/media/items?libraryPath=${encodeURIComponent(request_.libraryPath)}&itemId=${encodeURIComponent(request_.itemId)}`

  return {
    async tools() {
      return (await call<{ tools: MediaToolStatus[] }>('/media/tools')).tools
    },
    async installTool(name: MediaToolName) {
      return (
        await call<{ tool: MediaToolStatus }>(`/media/tools/${encodeURIComponent(name)}/install`, { method: 'POST' })
      ).tool
    },
    async configureTool(name: MediaToolName, path: string | null) {
      await call(`/media/tools/${encodeURIComponent(name)}`, { method: 'PUT', body: { path } })
    },
    async models() {
      return (await call<{ models: SpeechModelStatus[] }>('/media/transcription/models')).models
    },
    async installModel(id: string) {
      return (
        await call<{ model: SpeechModelStatus }>(`/media/transcription/models/${encodeURIComponent(id)}/install`, {
          method: 'POST'
        })
      ).model
    },
    async createLibrary(request_: { path: string; name?: string }) {
      return (await call<{ library: MediaLibrary }>('/media/libraries', { method: 'POST', body: request_ })).library
    },
    async openLibrary(path: string) {
      return (await call<{ library: MediaLibrary }>('/media/libraries/open', { method: 'POST', body: { path } }))
        .library
    },
    async items(path: string) {
      return (await call<{ items: MediaItem[] }>(`/media/libraries/items?path=${encodeURIComponent(path)}`)).items
    },
    async videoUrl(request_: { libraryPath: string; itemId: string }) {
      const connection = await options.connection()
      const query = `libraryPath=${encodeURIComponent(request_.libraryPath)}&itemId=${encodeURIComponent(request_.itemId)}`
      const token = connection.token ? `&token=${encodeURIComponent(connection.token)}` : ''
      return `${connection.endpoint.replace(/\/+$/, '')}/media/video?${query}${token}`
    },
    async importMedia(request_: { libraryPath: string; entries: readonly ImportMediaEntry[] }) {
      return (await call<{ items: MediaItem[] }>('/media/libraries/import', { method: 'POST', body: request_ })).items
    },
    async removeItem(request_: { libraryPath: string; itemId: string; permanent?: boolean }) {
      await call(`${itemPath(request_)}${request_.permanent ? '&permanent=1' : ''}`, { method: 'DELETE' })
    },
    async saveSubtitle(request_: { libraryPath: string; itemId: string; track: SubtitleTrack }) {
      await call('/media/items/subtitles', { method: 'POST', body: request_ })
    },
    async startDownload(request_: MediaDownloadRequest) {
      return (await call<{ job: MediaDownloadJob }>('/media/downloads', { method: 'POST', body: request_ })).job
    },
    async downloads() {
      return (await call<{ jobs: MediaDownloadJob[] }>('/media/downloads')).jobs
    },
    async controlDownload(id: string, action: 'pause' | 'resume' | 'cancel') {
      await call(`/media/downloads/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
    },
    async transcribe(request_: TranscribeMediaRequest) {
      return (
        await call<{ transcription: TranscribeMediaResult }>('/media/transcriptions', {
          method: 'POST',
          body: request_
        })
      ).transcription
    },
    async translate(request_: TranslateSubtitlesRequest) {
      return (
        await call<{ translation: TranslateSubtitlesResult }>('/media/subtitles/translate', {
          method: 'POST',
          body: request_
        })
      ).translation
    },
    async exportClips(request_: ExportClipsRequest) {
      return (await call<{ files: MediaExportFile[] }>('/media/exports/clips', { method: 'POST', body: request_ }))
        .files
    },
    async exportFcpxml(request_: ExportFcpxmlRequest) {
      return (await call<{ export: ExportFcpxmlResult }>('/media/exports/fcpxml', { method: 'POST', body: request_ }))
        .export
    }
  }
}
