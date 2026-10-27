import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentApp, type AgentAppServices } from '@keundal/agent-host/http'
import {
  MediaDownloadService,
  MediaExportService,
  MediaLibraryService,
  MediaToolsService,
  SubtitleTranslationService,
  type ExportClipsRequest,
  type ExportFcpxmlRequest,
  type ExportFcpxmlResult,
  type InstallMediaToolRequest,
  type MediaDownloadJob,
  type MediaDownloadProgress,
  type MediaDownloadRequest,
  type MediaExportFile,
  type MediaItem,
  type MediaLibrary,
  type MediaToolName,
  type MediaToolStatus,
  type SaveSubtitleRequest,
  type TranslateSubtitlesRequest,
  type TranslateSubtitlesResult
} from '@keundal/media'
import {
  MediaTranscriptionService,
  type SpeechModelStatus,
  type TranscribeMediaRequest,
  type TranscribeMediaResult
} from '@keundal/transcription'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const token = 'media-test-token'
const createdAt = '2026-10-26T00:00:00.000Z'

class FakeTools extends MediaToolsService {
  async status(): Promise<readonly MediaToolStatus[]> {
    return [{ name: 'yt-dlp', installed: false, path: null, version: null, source: null }]
  }

  async resolve(name: MediaToolName): Promise<string> {
    throw new Error(`${name} was not found`)
  }

  async install(request: InstallMediaToolRequest): Promise<MediaToolStatus> {
    return { name: request.name, installed: true, path: '/tools/yt-dlp', version: '2026.01.01', source: 'installed' }
  }

  async configure(): Promise<void> {}
}

class FakeLibrary extends MediaLibraryService {
  readonly tracks: SaveSubtitleRequest[] = []
  /** 비디오 스트림 테스트에서 실제 파일 경로를 넣습니다. */
  videoPath = 'clip.mp4'
  videoPresent = true
  get items(): readonly MediaItem[] {
    return [
      {
        id: 'item-1',
        title: '첫 영상',
        createdAt,
        updatedAt: createdAt,
        storage: 'copy',
        origin: { kind: 'local', path: '/videos/clip.mp4' },
        video: { path: this.videoPath, present: this.videoPresent },
        subtitleTracks: []
      }
    ]
  }

  async create(request: { path: string; name?: string }): Promise<MediaLibrary> {
    return { path: request.path, name: request.name ?? 'library', createdAt, updatedAt: createdAt }
  }

  async open(request: { path: string }): Promise<MediaLibrary> {
    return { path: request.path, name: 'library', createdAt, updatedAt: createdAt }
  }

  async list(): Promise<readonly MediaItem[]> {
    return this.items
  }

  async read(_libraryPath: string, itemId: string): Promise<MediaItem> {
    const item = this.items.find((entry) => entry.id === itemId)
    if (!item) throw new Error(`unknown item: ${itemId}`)
    return item
  }

  async import(request: { entries: readonly { filePath: string }[] }): Promise<readonly MediaItem[]> {
    return this.items.slice(0, request.entries.length)
  }

  async remove(): Promise<void> {}

  async relocate(): Promise<MediaItem> {
    return this.items[0]!
  }

  async saveSubtitle(request: SaveSubtitleRequest): Promise<void> {
    this.tracks.push(request)
  }
}

class FakeDownload extends MediaDownloadService {
  readonly jobs: MediaDownloadJob[] = []

  async start(request: MediaDownloadRequest): Promise<MediaDownloadJob> {
    const job: MediaDownloadJob = {
      jobId: `job-${this.jobs.length + 1}`,
      state: 'queued',
      percent: null,
      downloadedBytes: null,
      totalBytes: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
      message: null,
      url: request.url,
      title: null,
      filePath: null
    }
    this.jobs.push(job)
    return job
  }

  async pause(jobId: string): Promise<void> {
    this.replace(jobId, { state: 'paused' })
  }

  async resume(jobId: string): Promise<MediaDownloadJob> {
    return this.replace(jobId, { state: 'queued' })
  }

  async cancel(jobId: string): Promise<void> {
    this.replace(jobId, { state: 'cancelled' })
  }

  list(): readonly MediaDownloadJob[] {
    return this.jobs
  }

  async wait(jobId: string): Promise<MediaDownloadJob> {
    const job = this.jobs.find((entry) => entry.jobId === jobId)
    if (!job) throw new Error(`unknown download job: ${jobId}`)
    return job
  }

  subscribe(listener: (progress: MediaDownloadProgress) => void): () => void {
    listener({
      jobId: 'job-1',
      state: 'running',
      percent: 5,
      downloadedBytes: 1,
      totalBytes: 20,
      speedBytesPerSecond: null,
      etaSeconds: null,
      message: null
    })
    return () => {}
  }

  private replace(jobId: string, change: Partial<MediaDownloadJob>): MediaDownloadJob {
    const index = this.jobs.findIndex((entry) => entry.jobId === jobId)
    if (index < 0) throw new Error(`unknown download job: ${jobId}`)
    const next = { ...this.jobs[index]!, ...change }
    this.jobs[index] = next
    return next
  }
}

class FakeTranscription extends MediaTranscriptionService {
  async models(): Promise<readonly SpeechModelStatus[]> {
    return [
      { id: 'tiny', label: 'Tiny', url: 'https://example.com/ggml-tiny.bin', bytes: 1, installed: false, path: null }
    ]
  }

  async installModel(request: { id: string }): Promise<SpeechModelStatus> {
    return {
      id: request.id,
      label: 'Tiny',
      url: 'https://example.com/ggml-tiny.bin',
      bytes: 1,
      installed: true,
      path: '/models/ggml-tiny.bin'
    }
  }

  async transcribe(request: TranscribeMediaRequest): Promise<TranscribeMediaResult> {
    return {
      model: request.model ?? 'tiny',
      language: request.language ?? 'ko',
      segments: [{ startMs: 0, endMs: 900, text: '안녕하세요' }],
      words: [{ text: '안녕하세요', startMs: 0, endMs: 900 }]
    }
  }
}

class FakeTranslation extends SubtitleTranslationService {
  async translate(request: TranslateSubtitlesRequest): Promise<TranslateSubtitlesResult> {
    return {
      track: {
        id: `translation:${request.targetLanguage}`,
        kind: 'translation',
        language: request.targetLanguage,
        segments: request.track.segments
      },
      failed: 0,
      skipped: 0,
      requests: 1
    }
  }
}

class FakeExport extends MediaExportService {
  async clips(request: ExportClipsRequest): Promise<readonly MediaExportFile[]> {
    return request.clips.map((clip) => ({ clipId: clip.id, name: clip.name, path: `/out/${clip.name}.mp4` }))
  }

  async fcpxml(request: ExportFcpxmlRequest): Promise<ExportFcpxmlResult> {
    return { path: request.outputPath, clipCount: request.clips.length }
  }
}

const baseServices = (): Omit<AgentAppServices, 'run'> => ({
  steer: () => 0,
  cancel: () => false,
  subscribe: () => {
    throw new Error('unused')
  },
  session: {
    get: async () => undefined,
    list: async () => [],
    commit: async () => {
      throw new Error('unused')
    },
    delete: async () => undefined
  },
  generation: {
    get: async () => undefined,
    list: async () => [],
    recover: async () => []
  },
  models: () => [{ id: 'test', provider: 'openai', contextWindow: 2000, maxOutputTokens: 200 }],
  title: async () => '제목'
})

async function setup(t: TestContext, withMedia: boolean, withTranscription = true, withTranslation = true) {
  const ctx = new Context()
  const tools = new FakeTools(ctx)
  const library = new FakeLibrary(ctx)
  const download = new FakeDownload(ctx)
  const transcription = new FakeTranscription(ctx)
  const translation = new FakeTranslation(ctx)
  const exporter = new FakeExport(ctx)
  const services: AgentAppServices = {
    ...baseServices(),
    run: () => {
      throw new Error('unused')
    },
    ...(withMedia
      ? {
          media: {
            library,
            tools,
            download,
            ...(withTranscription ? { transcription } : {}),
            ...(withTranslation ? { translation } : {}),
            export: exporter
          }
        }
      : {})
  }
  const server = createServer(createAgentApp(services, { token }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  t.onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  const base = `http://127.0.0.1:${address.port}`
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  }
  return { call, base, tools, library, download }
}

test('도구 상태와 설치 요청을 미디어 서비스로 전달한다', async (t) => {
  const { call } = await setup(t, true)
  const status = await call('GET', '/media/tools')
  expect(status.status).toBe(200)
  expect(status.json.tools).toEqual([{ name: 'yt-dlp', installed: false, path: null, version: null, source: null }])
  const installed = await call('POST', '/media/tools/yt-dlp/install')
  expect(installed.status).toBe(200)
  expect(installed.json.tool).toMatchObject({ name: 'yt-dlp', installed: true })
  expect((await call('POST', '/media/tools/nope/install')).status).toBe(400)
})

test('자료库를 만들고 항목 목록을 조회한다', async (t) => {
  const { call } = await setup(t, true)
  const created = await call('POST', '/media/libraries', { path: '/libraries/one.vimpo', name: '내 자료库' })
  expect(created.status).toBe(201)
  expect(created.json.library).toMatchObject({ path: '/libraries/one.vimpo', name: '내 자료库' })
  const listed = await call('GET', '/media/libraries/items?path=%2Flibraries%2Fone.vimpo')
  expect(listed.status).toBe(200)
  expect((listed.json.items as unknown[]).length).toBe(1)
  const item = await call('GET', '/media/items?libraryPath=%2Flibraries%2Fone.vimpo&itemId=item-1')
  expect(item.status).toBe(200)
  expect(item.json.item).toMatchObject({ id: 'item-1', title: '첫 영상' })
})

test('자막 트랙을 저장하면 204로 응답한다', async (t) => {
  const { call, library } = await setup(t, true)
  const result = await call('POST', '/media/items/subtitles', {
    libraryPath: '/libraries/one.vimpo',
    itemId: 'item-1',
    track: {
      id: 'original',
      kind: 'original',
      language: 'ko',
      segments: [{ startMs: 0, endMs: 1200, text: '안녕하세요' }]
    }
  })
  expect(result.status).toBe(204)
  expect(library.tracks).toHaveLength(1)
  expect(library.tracks[0]!.track.segments[0]!.speaker).toBeNull()
})

test('다운로드 작업을 만들고 목록과 제어 상태를 돌려준다', async (t) => {
  const { call } = await setup(t, true)
  const started = await call('POST', '/media/downloads', {
    url: 'https://example.com/watch?v=1',
    outputDirectory: '/inbox',
    format: '720p'
  })
  expect(started.status).toBe(202)
  expect(started.json.job).toMatchObject({ state: 'queued', url: 'https://example.com/watch?v=1' })
  const listed = await call('GET', '/media/downloads')
  expect((listed.json.jobs as unknown[]).length).toBe(1)
  const paused = await call('POST', '/media/downloads/job-1/pause')
  expect(paused.status).toBe(200)
  expect((paused.json.jobs as { state: string }[])[0]!.state).toBe('paused')
})

test('다운로드 진행률을 이벤트 스트림으로 전달한다', async (t) => {
  const { base } = await setup(t, true)
  const controller = new AbortController()
  const response = await fetch(`${base}/media/downloads/events?replay=1`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal
  })
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  const chunk = await reader.read()
  controller.abort()
  const text = new TextDecoder().decode(chunk.value)
  expect(text.startsWith('id: 1\ndata: ')).toBe(true)
  expect(text).toContain('"jobId":"job-1"')
})

test('미디어 경로가 아닌 요청은 404로 응답한다', async (t) => {
  const { call } = await setup(t, true)
  const result = await call('GET', '/media/unknown')
  expect(result.status).toBe(404)
  expect(result.json.error).toContain('no media route')
})

test('미디어 서비스가 없으면 503으로 응답한다', async (t) => {
  const { call } = await setup(t, false)
  const result = await call('GET', '/media/tools')
  expect(result.status).toBe(503)
})

test('음성 인식 모델 목록과 전사 요청을 서비스로 전달한다', async (t) => {
  const { call } = await setup(t, true)
  const models = await call('GET', '/media/transcription/models')
  expect(models.status).toBe(200)
  expect((models.json.models as { id: string }[])[0]!.id).toBe('tiny')
  const installed = await call('POST', '/media/transcription/models/tiny/install')
  expect(installed.status).toBe(200)
  expect(installed.json.model).toMatchObject({ id: 'tiny', installed: true })
  const transcription = await call('POST', '/media/transcriptions', {
    filePath: '/videos/clip.mp4',
    language: 'ko'
  })
  expect(transcription.status).toBe(200)
  expect(transcription.json.transcription).toMatchObject({ language: 'ko' })
})

test('음성 인식 서비스가 없으면 전사 경로가 503으로 응답한다', async (t) => {
  const { call } = await setup(t, true, false)
  const result = await call('GET', '/media/transcription/models')
  expect(result.status).toBe(503)
})

test('자막 번역 요청을 서비스로 전달한다', async (t) => {
  const { call } = await setup(t, true)
  const result = await call('POST', '/media/subtitles/translate', {
    track: {
      id: 'original',
      kind: 'original',
      language: 'en',
      segments: [{ startMs: 0, endMs: 900, text: 'hello' }]
    },
    targetLanguage: 'ko',
    model: 'gpt-4.1-mini',
    batchSize: 4
  })
  expect(result.status).toBe(200)
  const translation = result.json.translation as { track: { id: string; language: string } }
  expect(translation.track.id).toBe('translation:ko')
  expect(translation.track.language).toBe('ko')
})

test('번역 서비스가 없으면 번역 경로가 503으로 응답한다', async (t) => {
  const { call } = await setup(t, true, true, false)
  const result = await call('POST', '/media/subtitles/translate', {
    track: { id: 'original', kind: 'original', language: 'en', segments: [] },
    targetLanguage: 'ko',
    model: 'gpt-4.1-mini'
  })
  expect(result.status).toBe(503)
})

test('비디오 스트림은 쿼리 토큰을 받고 Range 요청을 지킨다', async (t) => {
  const { base, library } = await setup(t, true)
  const directory = await mkdtemp(join(tmpdir(), 'keundal-video-'))
  const file = join(directory, 'clip.mp4')
  await writeFile(file, '0123456789')
  t.onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  library.videoPath = file

  const url = `${base}/media/video?libraryPath=%2Flibraries%2Fone&itemId=item-1&token=${token}`
  const full = await fetch(url)
  expect(full.status).toBe(200)
  expect(full.headers.get('accept-ranges')).toBe('bytes')
  expect(await full.text()).toBe('0123456789')

  const partial = await fetch(url, { headers: { range: 'bytes=2-4' } })
  expect(partial.status).toBe(206)
  expect(partial.headers.get('content-range')).toBe('bytes 2-4/10')
  expect(await partial.text()).toBe('234')
})

test('비디오 스트림에서 토큰이 틀리면 401로 응답한다', async (t) => {
  const { base } = await setup(t, true)
  const response = await fetch(`${base}/media/video?libraryPath=%2Fl&itemId=item-1&token=wrong-token`)
  expect(response.status).toBe(401)
})

test('영상 파일이 없으면 비디오 스트림이 404로 응답한다', async (t) => {
  const { base, library } = await setup(t, true)
  library.videoPresent = false
  const response = await fetch(`${base}/media/video?libraryPath=%2Fl&itemId=item-1&token=${token}`)
  expect(response.status).toBe(404)
})

test('클립 내보내기와 FCPXML 요청을 서비스로 전달한다', async (t) => {
  const { call } = await setup(t, true)
  const clips = [{ id: 'c1', name: '하나', startMs: 0, endMs: 1_000 }]
  const exported = await call('POST', '/media/exports/clips', {
    libraryPath: '/libraries/one',
    itemId: 'item-1',
    outputDirectory: '/out',
    clips
  })
  expect(exported.status).toBe(200)
  expect((exported.json.files as { path: string }[])[0]!.path).toBe('/out/하나.mp4')
  const fcpxml = await call('POST', '/media/exports/fcpxml', {
    libraryPath: '/libraries/one',
    itemId: 'item-1',
    outputPath: '/out/clips.fcpxml',
    clips
  })
  expect(fcpxml.status).toBe(200)
  expect(fcpxml.json.export).toEqual({ path: '/out/clips.fcpxml', clipCount: 1 })
  expect((await call('POST', '/media/exports/clips', { clips: [] })).status).toBe(400)
})
