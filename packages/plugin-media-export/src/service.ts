import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import type { ExecutionOptions } from '@keundal/core'
import {
  MediaExportService,
  type ExportClipsRequest,
  type ExportFcpxmlRequest,
  type ExportFcpxmlResult,
  type MediaClip,
  type MediaExportFile,
  type MediaLibraryService,
  type MediaToolsService,
  type SubtitleTrack
} from '@keundal/media'
import type { ShellService } from '@keundal/shell'
import type { Context } from 'cordis'

import { buildAss } from './ass.js'
import { buildFcpxml } from './fcpxml.js'

export interface MediaExportConfig {
  /** 자막 파일 같은 작업 파일을 둘 디렉터리입니다. 생략하면 시스템 임시 디렉터리를 씁니다. */
  readonly workDirectory?: string
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function validateClips(value: unknown): readonly MediaClip[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('clips must be a non-empty array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new TypeError(`clips[${index}] is invalid`)
    const clip = entry as Record<string, unknown>
    const startMs = clip.startMs
    const endMs = clip.endMs
    if (typeof startMs !== 'number' || typeof endMs !== 'number' || !Number.isFinite(startMs)) {
      throw new TypeError(`clips[${index}] needs numeric times`)
    }
    if (startMs < 0 || endMs <= startMs) throw new TypeError(`clips[${index}] has an invalid range`)
    return {
      id: requireText(clip.id, `clips[${index}].id`),
      name: requireText(clip.name, `clips[${index}].name`),
      startMs,
      endMs
    }
  })
}

function findTrack(tracks: readonly SubtitleTrack[], trackId: string | undefined): SubtitleTrack {
  if (trackId === undefined) throw new TypeError('trackId is required to burn subtitles')
  const track = tracks.find((entry) => entry.id === trackId)
  if (!track) throw new Error(`subtitle track not found: ${trackId}`)
  return track
}

function quote(value: string): string {
  if (process.platform !== 'win32') return `'${value.replace(/'/g, `'\\''`)}'`
  // cmd.exe는 역슬래시를 이스케이프로 쓰지 않으므로, 인용문자가 든 값은 받지 않습니다.
  if (value.includes('"')) throw new TypeError('value must not contain a double quote')
  return `"${value}"`
}

/** ffmpeg 필터 인자에서 경로와 문자열을 안전하게 표기합니다. */
function filterValue(value: string, extra: readonly string[] = []): string {
  let result = ''
  for (const character of value) {
    if (character === '\\') result += '\\\\'
    else if (character === ':' || character === "'" || extra.includes(character)) result += `\\${character}`
    else result += character
  }
  return result
}

function escapeFilterText(value: string): string {
  return filterValue(value, [','])
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3)
}

function summarize(stderr: string, tool: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .at(-1)
  return line === undefined ? `${tool} failed` : `${tool}: ${line}`
}

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\0]/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : 'clip'
}

/** `yt-dlp`와 `ffmpeg`로 클립을 만들고 FCPXML을 씁니다. */
export class LocalMediaExportService extends MediaExportService {
  private readonly shell: ShellService
  private readonly tools: MediaToolsService
  private readonly library: MediaLibraryService
  private readonly workDirectory: string

  constructor(ctx: Context, config: MediaExportConfig = {}) {
    super(ctx)
    this.shell = ctx.shell
    this.tools = ctx.mediaTools
    this.library = ctx.media
    this.workDirectory = resolve(config.workDirectory ?? tmpdir())
  }

  async clips(request: ExportClipsRequest, options: ExecutionOptions = {}): Promise<readonly MediaExportFile[]> {
    options.signal?.throwIfAborted()
    if (!request || typeof request !== 'object') throw new TypeError('request is required')
    const clips = validateClips(request.clips)
    const libraryPath = requireText(request.libraryPath, 'libraryPath')
    const itemId = requireText(request.itemId, 'itemId')
    const outputDirectory = resolve(requireText(request.outputDirectory, 'outputDirectory'))
    const item = await this.library.read(libraryPath, itemId, options)
    if (!item.video.present) throw new Error('video file is missing')
    const track = request.burnSubtitles ? findTrack(item.subtitleTracks, request.trackId) : null
    const ffmpeg = await this.tools.resolve('ffmpeg', options)
    await mkdir(outputDirectory, { recursive: true })
    const directory = await mkdtemp(join(this.workDirectory, 'keundal-export-'))
    const files: MediaExportFile[] = []
    const used = new Set<string>()
    try {
      for (const clip of clips) {
        options.signal?.throwIfAborted()
        let name = safeName(clip.name)
        let suffix = 2
        while (used.has(name.toLowerCase())) {
          name = `${safeName(clip.name)}-${suffix}`
          suffix += 1
        }
        used.add(name.toLowerCase())
        const target = join(outputDirectory, `${name}.mp4`)
        const filters: string[] = []
        if (track) {
          const subtitlePath = join(directory, `${name}.ass`)
          await writeFile(subtitlePath, buildAss(track.segments, clip.startMs), 'utf8')
          filters.push(`subtitles=filename='${filterValue(subtitlePath)}'`)
        }
        const watermark = request.watermark?.trim()
        if (watermark) {
          filters.push(
            `drawtext=text='${escapeFilterText(watermark)}':x=w-tw-24:y=h-th-24:fontsize=28:fontcolor=white@0.85`
          )
        }
        const command = [
          quote(ffmpeg),
          '-y',
          '-loglevel',
          'error',
          '-ss',
          seconds(clip.startMs),
          '-t',
          seconds(clip.endMs - clip.startMs),
          '-i',
          quote(item.video.path),
          ...(filters.length > 0 ? ['-vf', quote(filters.join(','))] : []),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          quote(target)
        ].join(' ')
        const result = await this.shell.execute({ command }, options)
        if (result.exitCode !== 0) throw new Error(summarize(result.stderr, `ffmpeg clip ${name}`))
        files.push({ clipId: clip.id, name, path: target })
      }
      return files
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async fcpxml(request: ExportFcpxmlRequest, options: ExecutionOptions = {}): Promise<ExportFcpxmlResult> {
    options.signal?.throwIfAborted()
    if (!request || typeof request !== 'object') throw new TypeError('request is required')
    const clips = validateClips(request.clips)
    const item = await this.library.read(
      requireText(request.libraryPath, 'libraryPath'),
      requireText(request.itemId, 'itemId'),
      options
    )
    if (!item.video.present) throw new Error('video file is missing')
    const outputPath = resolve(requireText(request.outputPath, 'outputPath'))
    await mkdir(dirname(outputPath), { recursive: true })
    const title = request.title === undefined ? item.title : requireText(request.title, 'title')
    await writeFile(outputPath, buildFcpxml({ title, sourceUrl: pathToFileURL(item.video.path).href, clips }), 'utf8')
    return { path: outputPath, clipCount: clips.length }
  }
}
