import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import type { URL } from 'node:url'

import type { MediaDownloadRequest, MediaDownloadState, MediaItemStorage, SubtitleTrack } from '@keundal/media'

import type { AgentHostMedia } from './contracts.js'
import { openEventStream, sendJson } from './respond.js'

export interface MediaRequestContext {
  readonly media: AgentHostMedia
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly url: URL
  /** 경로를 `/`로 나눈 조각입니다. 첫 조각은 `media`입니다. */
  readonly segments: readonly string[]
  readonly body: () => Promise<string>
  /** 클라이언트가 끊으면 중단됩니다. */
  readonly signal: AbortSignal
}

const TOOL_NAMES = ['yt-dlp', 'ffmpeg'] as const
const FORMATS = ['best', '1080p', '720p', 'audio'] as const
const SUBTITLE_POLICIES = ['none', 'builtin'] as const
const STORAGE_KINDS = ['copy', 'link'] as const
const DOWNLOAD_ACTIONS = ['pause', 'resume', 'cancel'] as const

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return text(value, name)
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`)
  return value
}

function toolName(value: string | undefined): 'yt-dlp' | 'ffmpeg' {
  return oneOf(value, 'tool name', TOOL_NAMES)
}

function query(url: URL, name: string): string {
  return text(url.searchParams.get(name), name)
}

function parseSegments(value: unknown): SubtitleTrack['segments'] {
  if (!Array.isArray(value)) throw new Error('track.segments must be an array')
  return value.map((entry, index) => {
    const segment = record(entry)
    const startMs = segment.startMs
    const endMs = segment.endMs
    if (typeof startMs !== 'number' || typeof endMs !== 'number') {
      throw new Error(`track.segments[${index}] needs numeric times`)
    }
    return {
      startMs,
      endMs,
      text: text(segment.text, `track.segments[${index}].text`),
      speaker: optionalText(segment.speaker, `track.segments[${index}].speaker`) ?? null
    }
  })
}

function parseTrack(value: unknown): SubtitleTrack {
  const track = record(value)
  return {
    id: text(track.id, 'track.id'),
    kind: oneOf(track.kind, 'track.kind', ['original', 'translation'] as const),
    language: text(track.language, 'track.language'),
    segments: parseSegments(track.segments)
  }
}

function parseDownloadRequest(value: unknown): MediaDownloadRequest {
  const body = record(value)
  const cookies = optionalText(body.cookiesFromBrowser, 'cookiesFromBrowser')
  return {
    url: text(body.url, 'url'),
    outputDirectory: text(body.outputDirectory, 'outputDirectory'),
    ...(body.format === undefined ? {} : { format: oneOf(body.format, 'format', FORMATS) }),
    ...(body.subtitles === undefined ? {} : { subtitles: oneOf(body.subtitles, 'subtitles', SUBTITLE_POLICIES) }),
    ...(cookies === undefined ? {} : { cookiesFromBrowser: cookies })
  }
}

function isTerminal(state: MediaDownloadState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

const VIDEO_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav'
}

/** Range 요청을 지원하는 파일 응답을 보냅니다. 플레이어가 중간부터 재생할 때 필요합니다. */
async function sendVideoFile(response: ServerResponse, path: string, range: string | undefined): Promise<void> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${path} is not a file`)
  const type = VIDEO_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const size = info.size
  const matched = range === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  let start = 0
  let end = size - 1
  if (matched) {
    const from = matched[1] ?? ''
    const to = matched[2] ?? ''
    if (from === '' && to !== '') {
      start = Math.max(0, size - Number(to))
    } else {
      start = Number(from)
      if (to !== '') end = Math.min(Number(to), size - 1)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      response.writeHead(416, { 'content-range': `bytes */${size}` })
      response.end()
      return
    }
  }
  const partial = matched !== null
  response.writeHead(partial ? 206 : 200, {
    'content-type': type,
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
  })
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start, end })
    stream.on('error', reject)
    response.on('close', () => stream.destroy())
    stream.on('end', resolve)
    stream.pipe(response)
  })
}

/** 음성 인식 서비스가 없으면 503을 보내고 undefined를 돌려줍니다. */
function requireTranscription(media: AgentHostMedia, response: ServerResponse) {
  if (media.transcription) return media.transcription
  sendJson(response, 503, { error: 'media transcription is not available' })
  return undefined
}

/**
 * 실패 사유를 HTTP 상태와 고정 코드로 바꿉니다.
 * 예외 메시지는 호스트 경로를 담을 수 있으므로 응답에 그대로 넣지 않습니다.
 */
function mediaFailure(error: unknown): { status: number; code: string } {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('not found') || message.includes('is missing')) {
    return { status: 404, code: 'media-not-found' }
  }
  if (message.includes('outside the configured root') || message.includes('must be') || message.includes('invalid')) {
    return { status: 400, code: 'media-invalid-request' }
  }
  if (message.includes('is not installed') || message.includes('is not available')) {
    return { status: 409, code: 'media-unavailable' }
  }
  return { status: 400, code: 'media-request-failed' }
}

/** 자막 번역 서비스가 없으면 503을 보내고 undefined를 돌려줍니다. */
function requireTranslation(media: AgentHostMedia, response: ServerResponse) {
  if (media.translation) return media.translation
  sendJson(response, 503, { error: 'subtitle translation is not available' })
  return undefined
}

/** 클립 내보내기 서비스가 없으면 503을 보내고 undefined를 돌려줍니다. */
function requireExport(media: AgentHostMedia, response: ServerResponse) {
  if (media.export) return media.export
  sendJson(response, 503, { error: 'media export is not available' })
  return undefined
}

function parseClips(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('clips must be a non-empty array')
  return value.map((entry, index) => {
    const clip = record(entry)
    return {
      id: text(clip.id, `clips[${index}].id`),
      name: text(clip.name, `clips[${index}].name`),
      startMs: number(clip.startMs, `clips[${index}].startMs`),
      endMs: number(clip.endMs, `clips[${index}].endMs`)
    }
  })
}

/**
 * `/media` 아래의 미디어 요청을 처리합니다.
 * 라우터가 이미 인증과 CORS를 처리했으므로 이 함수는 본문과 경로만 다룹니다.
 */
export async function handleMediaRequest(context: MediaRequestContext): Promise<void> {
  const { media, request, response, url, segments, body, signal } = context
  const method = request.method ?? 'GET'
  const route = segments.slice(1).join('/')
  try {
    if (method === 'GET' && route === 'tools') {
      return sendJson(response, 200, { tools: await media.tools.status({ signal }) })
    }

    if (method === 'POST' && segments.length === 4 && segments[1] === 'tools' && segments[3] === 'install') {
      const tool = await media.tools.install({ name: toolName(segments[2]) }, { signal })
      return sendJson(response, 200, { tool })
    }

    if (method === 'PUT' && segments.length === 3 && segments[1] === 'tools') {
      const name = toolName(segments[2])
      const payload = record(JSON.parse(await body()))
      const path = payload.path === null ? null : text(payload.path, 'path')
      await media.tools.configure({ name, path }, { signal })
      response.writeHead(204)
      response.end()
      return
    }

    if (method === 'POST' && route === 'libraries') {
      const payload = record(JSON.parse(await body()))
      const name = optionalText(payload.name, 'name')
      const library = await media.library.create(
        { path: text(payload.path, 'path'), ...(name === undefined ? {} : { name }) },
        { signal }
      )
      return sendJson(response, 201, { library })
    }

    if (method === 'POST' && route === 'libraries/open') {
      const payload = record(JSON.parse(await body()))
      return sendJson(response, 200, {
        library: await media.library.open({ path: text(payload.path, 'path') }, { signal })
      })
    }

    if (method === 'GET' && route === 'video') {
      const item = await media.library.read(query(url, 'libraryPath'), query(url, 'itemId'), { signal })
      if (!item.video.present) return sendJson(response, 404, { error: 'video file is missing' })
      return await sendVideoFile(response, item.video.path, request.headers.range)
    }

    if (method === 'GET' && route === 'libraries/items') {
      return sendJson(response, 200, { items: await media.library.list(query(url, 'path'), { signal }) })
    }

    if (method === 'POST' && route === 'libraries/import') {
      const payload = record(JSON.parse(await body()))
      if (!Array.isArray(payload.entries)) throw new Error('entries must be an array')
      const entries = payload.entries.map((entry, index) => {
        const value = record(entry)
        return {
          filePath: text(value.filePath, `entries[${index}].filePath`),
          storage: oneOf(value.storage, `entries[${index}].storage`, STORAGE_KINDS) as MediaItemStorage,
          ...(value.title === undefined ? {} : { title: text(value.title, `entries[${index}].title`) })
        }
      })
      const items = await media.library.import(
        { libraryPath: text(payload.libraryPath, 'libraryPath'), entries },
        { signal }
      )
      return sendJson(response, 201, { items })
    }

    if (method === 'GET' && route === 'items') {
      const item = await media.library.read(query(url, 'libraryPath'), query(url, 'itemId'), { signal })
      return sendJson(response, 200, { item })
    }

    if (method === 'DELETE' && route === 'items') {
      await media.library.remove(
        {
          libraryPath: query(url, 'libraryPath'),
          itemId: query(url, 'itemId'),
          permanent: url.searchParams.get('permanent') === '1'
        },
        { signal }
      )
      response.writeHead(204)
      response.end()
      return
    }

    if (method === 'POST' && route === 'items/subtitles') {
      const payload = record(JSON.parse(await body()))
      await media.library.saveSubtitle(
        {
          libraryPath: text(payload.libraryPath, 'libraryPath'),
          itemId: text(payload.itemId, 'itemId'),
          track: parseTrack(payload.track)
        },
        { signal }
      )
      response.writeHead(204)
      response.end()
      return
    }

    if (method === 'GET' && route === 'transcription/models') {
      const transcription = requireTranscription(media, response)
      if (!transcription) return
      return sendJson(response, 200, { models: await transcription.models({ signal }) })
    }

    if (
      method === 'POST' &&
      segments.length === 5 &&
      segments[1] === 'transcription' &&
      segments[2] === 'models' &&
      segments[4] === 'install'
    ) {
      const transcription = requireTranscription(media, response)
      if (!transcription) return
      const model = await transcription.installModel({ id: text(segments[3], 'model id') }, { signal })
      return sendJson(response, 200, { model })
    }

    if (method === 'POST' && route === 'transcriptions') {
      const transcription = requireTranscription(media, response)
      if (!transcription) return
      const payload = record(JSON.parse(await body()))
      const language = optionalText(payload.language, 'language')
      const model = optionalText(payload.model, 'model')
      const transcriptionResult = await transcription.transcribe(
        {
          filePath: text(payload.filePath, 'filePath'),
          ...(language === undefined ? {} : { language }),
          ...(model === undefined ? {} : { model })
        },
        { signal }
      )
      return sendJson(response, 200, { transcription: transcriptionResult })
    }

    if (method === 'POST' && route === 'subtitles/translate') {
      const translation = requireTranslation(media, response)
      if (!translation) return
      const payload = record(JSON.parse(await body()))
      const result = await translation.translate(
        {
          track: parseTrack(payload.track),
          targetLanguage: text(payload.targetLanguage, 'targetLanguage'),
          model: text(payload.model, 'model'),
          ...(payload.title === undefined ? {} : { title: text(payload.title, 'title') }),
          ...(payload.prompt === undefined ? {} : { prompt: text(payload.prompt, 'prompt') }),
          ...(payload.batchSize === undefined ? {} : { batchSize: number(payload.batchSize, 'batchSize') }),
          ...(payload.concurrency === undefined ? {} : { concurrency: number(payload.concurrency, 'concurrency') }),
          ...(payload.context === undefined
            ? {}
            : { context: oneOf(payload.context, 'context', ['window', 'full'] as const) })
        },
        { signal }
      )
      return sendJson(response, 200, { translation: result })
    }

    if (method === 'POST' && route === 'exports/clips') {
      const exporter = requireExport(media, response)
      if (!exporter) return
      const payload = record(JSON.parse(await body()))
      const files = await exporter.clips(
        {
          libraryPath: text(payload.libraryPath, 'libraryPath'),
          itemId: text(payload.itemId, 'itemId'),
          outputDirectory: text(payload.outputDirectory, 'outputDirectory'),
          clips: parseClips(payload.clips),
          ...(payload.burnSubtitles === undefined ? {} : { burnSubtitles: Boolean(payload.burnSubtitles) }),
          ...(payload.trackId === undefined ? {} : { trackId: text(payload.trackId, 'trackId') }),
          ...(payload.watermark === undefined || payload.watermark === null
            ? {}
            : { watermark: text(payload.watermark, 'watermark') })
        },
        { signal }
      )
      return sendJson(response, 200, { files })
    }

    if (method === 'POST' && route === 'exports/fcpxml') {
      const exporter = requireExport(media, response)
      if (!exporter) return
      const payload = record(JSON.parse(await body()))
      const written = await exporter.fcpxml(
        {
          libraryPath: text(payload.libraryPath, 'libraryPath'),
          itemId: text(payload.itemId, 'itemId'),
          outputPath: text(payload.outputPath, 'outputPath'),
          clips: parseClips(payload.clips),
          ...(payload.title === undefined ? {} : { title: text(payload.title, 'title') })
        },
        { signal }
      )
      return sendJson(response, 200, { export: written })
    }

    if (method === 'POST' && route === 'downloads') {
      const request_ = parseDownloadRequest(JSON.parse(await body()))
      const abort = new AbortController()
      const disconnect = () => abort.abort()
      response.once('close', disconnect)
      try {
        const job = await media.download.start(request_, { signal: AbortSignal.any([signal, abort.signal]) })
        return sendJson(response, 202, { job })
      } finally {
        response.off('close', disconnect)
      }
    }

    if (method === 'GET' && route === 'downloads') {
      return sendJson(response, 200, { jobs: media.download.list() })
    }

    if (method === 'GET' && route === 'downloads/events') {
      const stream = openEventStream(response)
      const replay = url.searchParams.get('replay') === '1'
      const unsubscribe = media.download.subscribe((progress) => stream.write(progress), { replay })
      await new Promise<void>((resolve) => {
        const finish = () => {
          unsubscribe()
          resolve()
        }
        signal.addEventListener('abort', finish, { once: true })
        response.once('close', finish)
      })
      if (!response.writableEnded) response.end()
      return
    }

    if (method === 'POST' && segments.length === 4 && segments[1] === 'downloads') {
      const jobId = text(segments[2], 'jobId')
      const action = oneOf(segments[3], 'action', DOWNLOAD_ACTIONS)
      if (action === 'pause') {
        await media.download.pause(jobId, { signal })
        return sendJson(response, 200, { jobs: media.download.list() })
      }
      if (action === 'cancel') {
        await media.download.cancel(jobId, { signal })
        return sendJson(response, 200, { jobs: media.download.list() })
      }
      const job = await media.download.resume(jobId, { signal })
      return sendJson(response, 200, { job })
    }

    if (method === 'GET' && segments.length === 3 && segments[1] === 'downloads') {
      const jobId = text(segments[2], 'jobId')
      const job = media.download.list().find((entry) => entry.jobId === jobId)
      if (!job) return sendJson(response, 404, { error: `download job not found: ${jobId}` })
      if (isTerminal(job.state)) return sendJson(response, 200, { job })
      return sendJson(response, 200, { job: await media.download.wait(jobId, { signal }) })
    }

    sendJson(response, 404, { error: `no media route for ${method} ${url.pathname}` })
  } catch (error) {
    if (response.headersSent || response.writableEnded) {
      response.end()
      return
    }
    const failure = mediaFailure(error)
    sendJson(response, failure.status, { error: failure.code })
  }
}
