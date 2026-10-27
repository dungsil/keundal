import type {} from '@keundal/ui-layout/slots'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'
import { lazyView } from '@keundal/ui-slots'
import type {
  ExportClipsRequest,
  ExportFcpxmlRequest,
  ImportMediaEntry,
  MediaDownloadRequest,
  MediaToolName,
  SubtitleTrack,
  TranslateSubtitlesRequest
} from '@keundal/media'
import type { TranscribeMediaRequest } from '@keundal/transcription'
import type { Context } from 'cordis'

import { messages } from './locale'

export const name = 'ui-media'
export const inject = ['slots', 'chatRuntime']

const MediaSettings = lazyView(() => import('./views/MediaSettings.vue'), [
  'available',
  'tools',
  'installTool',
  'models',
  'installModel',
  'createLibrary',
  'items'
])
const LibraryPage = lazyView(() => import('./views/LibraryPage.vue'), [
  'available',
  'importMedia',
  'controlDownload',
  'items',
  'videoUrl',
  'createLibrary',
  'startDownload',
  'downloads',
  'exportClips',
  'exportFcpxml',
  'transcribe',
  'translate',
  'saveSubtitle',
  'llmModels'
])
const LibraryLink = lazyView(() => import('./views/LibraryLink.vue'), ['available', 'collapsed', 'close'])


/** 미디어 기능이 조립된 호스트에서만 설정 구역과 자료실 화면을 추가합니다. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  const available = async () => {
    try {
      return await runtime.platform.media?.available() ?? false
    } catch {
      return false
    }
  }
  // 플랫폼은 브라우저에서만 있으므로 각 함수가 호출 시점에 값을 읽습니다.
  const current = () => {
    const media = runtime.platform.media
    if (!media) throw new Error('media is not available in this runtime')
    return media
  }

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        key: 'media',
        order: 130,
        meta: { label: localizedText(messages, 'media.title'), icon: 'i-lucide-film', group: 'plugins' },
        inject: () => ({
          available,
          tools: () => current().tools(),
          installTool: (name: MediaToolName) => current().installTool(name),
          models: () => current().models(),
          installModel: (id: string) => current().installModel(id),
          createLibrary: (request: { path: string; name?: string }) => current().createLibrary(request),
          items: (path: string) => current().items(path)
        })
      },
      MediaSettings
    )
  )

  ctx.slots.inject('layout.sidebar', () =>
    ctx.slots.register(
      {
        name: 'layout.sidebar',
        id: 'library',
        order: 20,
        inject: () => ({ available })
      },
      LibraryLink
    )
  )

  ctx.slots.inject('page.library', () =>
    ctx.slots.register(
      {
        name: 'page.library',
        inject: () => ({
          available,
          importMedia: (request: { libraryPath: string; entries: readonly ImportMediaEntry[] }) => current().importMedia(request),
          controlDownload: (id: string, action: 'pause' | 'resume' | 'cancel') => current().controlDownload(id, action),
          items: (path: string) => current().items(path),
          videoUrl: (request: { libraryPath: string; itemId: string }) => current().videoUrl(request),
          createLibrary: (request: { path: string; name?: string }) => current().createLibrary(request),
          startDownload: (request: MediaDownloadRequest) => current().startDownload(request),
          downloads: () => current().downloads(),
          exportClips: (request: ExportClipsRequest) => current().exportClips(request),
          exportFcpxml: (request: ExportFcpxmlRequest) => current().exportFcpxml(request),
          transcribe: (request: TranscribeMediaRequest) => current().transcribe(request),
          translate: (request: TranslateSubtitlesRequest) => current().translate(request),
          saveSubtitle: (request: { libraryPath: string; itemId: string; track: SubtitleTrack }) =>
            current().saveSubtitle(request),
          llmModels: () => runtime.models.value.map((model) => model.value)
        })
      },
      LibraryPage
    )
  )
}

export type { ImportMediaEntry }
