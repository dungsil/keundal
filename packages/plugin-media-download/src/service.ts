import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { clearInterval, setInterval } from 'node:timers'

import type { ExecutionOptions } from '@keundal/core'
import {
  MediaDownloadService,
  type MediaDownloadFormat,
  type MediaDownloadJob,
  type MediaDownloadProgress,
  type MediaDownloadRequest,
  type MediaDownloadState,
  type MediaDownloadSubscriptionOptions,
  type MediaToolsService
} from '@keundal/media'
import type { ShellService } from '@keundal/shell'
import type { Context } from 'cordis'

const PROGRESS_PREFIX = /^\[download\][ \t]{1,8}(\d{1,3}(?:\.\d{1,3})?)%[ \t]{1,8}of[ \t]{1,8}/
const SIZE_PATTERN = /^([\d.]{1,16})([KMGT]?i?B)$/
const SPEED_PATTERN = /^([\d.]{1,16}|Unknown)[ \t]{0,8}([KMGT]?i?B)\/s$/
const ETA_PATTERN = /^([\d:]{1,12})$/

const UNITS: Readonly<Record<string, number>> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4
}

const TERMINAL: readonly MediaDownloadState[] = ['completed', 'failed', 'cancelled']

export interface MediaDownloadConfig {
  /** 진행 로그를 남길 디렉터리입니다. 지정하지 않으면 시스템 임시 디렉터리를 씁니다. */
  readonly workDirectory?: string
  /** 진행 로그를 확인하는 주기입니다. */
  readonly pollMs?: number
}

interface JobRecord {
  readonly id: string
  readonly request: MediaDownloadRequest
  readonly done: Promise<MediaDownloadJob>
  resolve: (job: MediaDownloadJob) => void
  state: MediaDownloadState
  percent: number | null
  downloadedBytes: number | null
  totalBytes: number | null
  speedBytesPerSecond: number | null
  etaSeconds: number | null
  message: string | null
  title: string | null
  filePath: string | null
  controller: AbortController | null
  paused: boolean
  task: Promise<void> | null
}

function requireUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : ''
  if (
    !globalThis.URL.canParse(url) ||
    !['http:', 'https:'].includes(new globalThis.URL(url).protocol) ||
    /[\0\r\n]/.test(url)
  ) {
    throw new TypeError('url must be an http or https link')
  }
  return url
}

function requireDirectory(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function parseFormat(value: MediaDownloadFormat | undefined): MediaDownloadFormat {
  if (value === undefined) return 'best'
  if (value !== 'best' && value !== '1080p' && value !== '720p' && value !== 'audio') {
    throw new TypeError('format must be best, 1080p, 720p or audio')
  }
  return value
}

function formatSelector(format: MediaDownloadFormat): string {
  if (format === 'audio') return 'bestaudio/best'
  if (format === '1080p') return 'bv*[height<=1080]+ba/b[height<=1080]/b'
  if (format === '720p') return 'bv*[height<=720]+ba/b[height<=720]/b'
  return 'bv*+ba/b'
}

function etaSeconds(value: string | undefined): number | null {
  if (!value) return null
  const parts = value.split(':').map((part) => Number.parseInt(part, 10))
  if (parts.some((part) => !Number.isFinite(part))) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

function bytes(value: string, unit: string): number | null {
  const size = Number.parseFloat(value)
  const scale = UNITS[unit]
  if (!Number.isFinite(size) || scale === undefined) return null
  return Math.round(size * scale)
}

/** yt-dlp가 남기는 진행 줄 하나를 해석합니다. 형식이 다르면 null을 반환합니다. */
export function parseProgressLine(
  line: string
): Pick<
  MediaDownloadProgress,
  'percent' | 'downloadedBytes' | 'totalBytes' | 'speedBytesPerSecond' | 'etaSeconds'
> | null {
  // 정규식 하나로 줄 전체를 해석하지 않습니다. 줄 길이에 따라 느려지지 않도록 순서대로 나눕니다.
  const head = PROGRESS_PREFIX.exec(line)
  if (!head) return null
  const percent = Number.parseFloat(head[1]!)
  const [sizePart, ...speedParts] = line.slice(head[0].length).split(' at ')
  const size = SIZE_PATTERN.exec((sizePart ?? '').replace(/^[ \t]*~/, '').trim())
  if (!size) return null
  const totalBytes = bytes(size[1]!, size[2]!)
  const [speedText, etaText] = speedParts.join(' at ').split(' ETA ')
  const speed = speedText === undefined ? null : SPEED_PATTERN.exec(speedText.trim())
  const speedValue = speed?.[1] === undefined || speed[1] === 'Unknown' ? null : Number.parseFloat(speed[1])
  const speedUnit = speed?.[2]
  const eta = etaText === undefined ? null : ETA_PATTERN.exec(etaText.trim())
  return {
    percent: Number.isFinite(percent) ? percent : null,
    downloadedBytes: totalBytes === null || !Number.isFinite(percent) ? null : Math.round((totalBytes * percent) / 100),
    totalBytes,
    speedBytesPerSecond:
      speedValue === null || !Number.isFinite(speedValue) || speedUnit === undefined
        ? null
        : Math.round(speedValue * (UNITS[speedUnit] ?? 1)),
    etaSeconds: eta === null ? null : etaSeconds(eta[1])
  }
}

function quote(value: string, template = false): string {
  if (process.platform !== 'win32') return `'${value.replace(/'/g, `'\\''`)}'`
  // cmd.exe는 역슬래시를 이스케이프로 쓰지 않으므로, 인용문자가 든 값은 받지 않습니다.
  if (/["!\r\n]/.test(value) || (!template && value.includes('%')))
    throw new TypeError('value contains unsafe cmd.exe characters')
  return `"${value}"`
}

export class LocalMediaDownloadService extends MediaDownloadService {
  private readonly shell: ShellService
  private readonly tools: MediaToolsService
  private readonly workDirectory: string
  private readonly pollMs: number
  private readonly jobs = new Map<string, JobRecord>()
  private readonly listeners = new Set<(progress: MediaDownloadProgress) => void>()
  private closed = false

  constructor(ctx: Context, config: MediaDownloadConfig = {}) {
    super(ctx)
    this.shell = ctx.shell
    this.tools = ctx.mediaTools
    this.workDirectory =
      config.workDirectory === undefined ? tmpdir() : requireDirectory(config.workDirectory, 'workDirectory')
    if (config.pollMs !== undefined) {
      if (!Number.isSafeInteger(config.pollMs) || config.pollMs < 10) throw new TypeError('pollMs must be an integer')
      this.pollMs = config.pollMs
    } else {
      this.pollMs = 500
    }
    ctx.fiber.effect(() => async () => {
      this.closed = true
      for (const job of this.jobs.values()) {
        job.paused = true
        job.controller?.abort()
        if (!TERMINAL.includes(job.state)) this.finish(job, 'cancelled', 'service disposed')
      }
      this.listeners.clear()
      await Promise.allSettled([...this.jobs.values()].map((job) => job.task))
    })
  }

  async start(request: MediaDownloadRequest, options: ExecutionOptions = {}): Promise<MediaDownloadJob> {
    options.signal?.throwIfAborted()
    if (this.closed) throw new Error('media download service disposed')
    if (!request || typeof request !== 'object') throw new TypeError('request is required')
    const url = requireUrl(request.url)
    const outputDirectory = resolve(requireDirectory(request.outputDirectory, 'outputDirectory'))
    const format = parseFormat(request.format)
    const subtitles = request.subtitles ?? 'none'
    if (subtitles !== 'none' && subtitles !== 'builtin') {
      throw new TypeError('subtitles must be none or builtin')
    }
    if (
      request.cookiesFromBrowser !== undefined &&
      request.cookiesFromBrowser !== null &&
      requireDirectory(request.cookiesFromBrowser, 'cookiesFromBrowser').length === 0
    ) {
      throw new TypeError('cookiesFromBrowser must be a browser name')
    }
    const id = randomUUID()
    let resolveJob: (job: MediaDownloadJob) => void = () => undefined
    const done = new Promise<MediaDownloadJob>((resolve) => {
      resolveJob = resolve
    })
    const record: JobRecord = {
      id,
      request: { ...request, url, outputDirectory, format, subtitles },
      done,
      resolve: resolveJob,
      state: 'queued',
      percent: null,
      downloadedBytes: null,
      totalBytes: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
      message: null,
      title: null,
      filePath: null,
      controller: null,
      paused: false,
      task: null
    }
    this.jobs.set(id, record)
    this.emit(record)
    globalThis.queueMicrotask(() => {
      this.launch(record)
    })
    return this.snapshot(record)
  }

  async pause(jobId: string, options: ExecutionOptions = {}): Promise<void> {
    options.signal?.throwIfAborted()
    const job = this.require(jobId)
    if (job.state !== 'running' && job.state !== 'queued') return
    job.paused = true
    job.controller?.abort()
    this.transition(job, 'paused', 'paused')
    await job.task
  }

  async resume(jobId: string, options: ExecutionOptions = {}): Promise<MediaDownloadJob> {
    options.signal?.throwIfAborted()
    if (this.closed) throw new Error('media download service disposed')
    const job = this.require(jobId)
    if (job.state !== 'paused') return this.snapshot(job)
    await job.task
    options.signal?.throwIfAborted()
    if (this.closed) throw new Error('media download service disposed')
    if (job.state !== 'paused') return this.snapshot(job)
    job.paused = false
    this.transition(job, 'queued', null)
    this.launch(job)
    return this.snapshot(job)
  }

  async cancel(jobId: string, options: ExecutionOptions = {}): Promise<void> {
    options.signal?.throwIfAborted()
    const job = this.require(jobId)
    if (TERMINAL.includes(job.state)) return
    job.paused = true
    job.controller?.abort()
    this.finish(job, 'cancelled', null)
    await job.task
  }

  list(): readonly MediaDownloadJob[] {
    return [...this.jobs.values()].map((job) => this.snapshot(job))
  }

  async wait(jobId: string, options: ExecutionOptions = {}): Promise<MediaDownloadJob> {
    options.signal?.throwIfAborted()
    const job = this.require(jobId)
    if (TERMINAL.includes(job.state)) return Promise.resolve(this.snapshot(job))
    return new Promise((resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error('wait aborted'))
      options.signal?.addEventListener('abort', abort, { once: true })
      void job.done.then((value) => {
        options.signal?.removeEventListener('abort', abort)
        resolve(value)
      })
    })
  }

  subscribe(
    listener: (progress: MediaDownloadProgress) => void,
    options: MediaDownloadSubscriptionOptions = {}
  ): () => void {
    options.signal?.throwIfAborted()
    if (this.closed) throw new Error('media download service disposed')
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.listeners.add(listener)
    const unsubscribe = () => {
      this.listeners.delete(listener)
      options.signal?.removeEventListener('abort', unsubscribe)
    }
    options.signal?.addEventListener('abort', unsubscribe, { once: true })
    try {
      if (options.replay) for (const job of this.jobs.values()) listener(this.progress(job))
    } catch (error) {
      unsubscribe()
      throw error
    }
    return unsubscribe
  }

  private launch(job: JobRecord): void {
    if (this.closed || job.task || job.state !== 'queued') return
    job.task = this.run(job).finally(() => {
      job.task = null
    })
  }

  private async run(job: JobRecord): Promise<void> {
    if (this.closed || job.paused || TERMINAL.includes(job.state)) return
    const controller = new globalThis.AbortController()
    job.controller = controller
    this.transition(job, 'running', null)
    let directory: string | null = null
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      const ytdlp = await this.tools.resolve('yt-dlp', { signal: controller.signal })
      const ffmpeg = await this.tools.resolve('ffmpeg', { signal: controller.signal }).catch(() => null)
      controller.signal.throwIfAborted()
      await mkdir(this.workDirectory, { recursive: true })
      directory = await mkdtemp(join(this.workDirectory, 'keundal-download-'))
      const log = join(directory, 'progress.log')
      const command = this.command(job, ytdlp, ffmpeg, log)
      timer = setInterval(() => {
        void this.readLog(job, log).catch(() => undefined)
      }, this.pollMs)
      controller.signal.throwIfAborted()
      const result = await this.shell.execute({ command }, { signal: controller.signal })
      clearInterval(timer)
      timer = undefined
      await this.readLog(job, log)
      if (job.paused || controller.signal.aborted) {
        if (job.state !== 'cancelled') this.transition(job, 'paused', 'paused')
        return
      }
      if (result.exitCode !== 0) {
        this.finish(
          job,
          'failed',
          summarize(result.stderr) ?? job.message ?? `yt-dlp exited with code ${result.exitCode}`
        )
        return
      }
      this.finish(job, 'completed', null)
    } catch (error) {
      clearInterval(timer)
      if (job.paused || controller.signal.aborted) {
        if (job.state !== 'cancelled') this.transition(job, 'paused', 'paused')
        return
      }
      this.finish(job, 'failed', error instanceof Error ? error.message : 'download failed')
    } finally {
      clearInterval(timer)
      job.controller = null
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private command(job: JobRecord, ytdlp: string, ffmpeg: string | null, log: string): string {
    const { request } = job
    quote(request.outputDirectory)
    const format = request.format ?? 'best'
    const parts = [
      quote(ytdlp),
      quote(request.url),
      '--newline',
      '--no-playlist',
      '--continue',
      '--no-mtime',
      '-o',
      quote(join(request.outputDirectory, '%(title)s.%(ext)s'), true),
      '--print',
      quote('after_move:filepath')
    ]
    if (format === 'audio') {
      parts.push('-f', quote(formatSelector(format)), '--extract-audio', '--audio-format', 'm4a')
    } else {
      parts.push('-f', quote(formatSelector(format)), '--merge-output-format', 'mp4')
    }
    if (request.subtitles === 'builtin') {
      parts.push('--write-subs', '--write-auto-subs', '--sub-langs', quote('all,-live_chat'), '--convert-subs', 'srt')
    }
    if (request.cookiesFromBrowser) parts.push('--cookies-from-browser', quote(request.cookiesFromBrowser))
    if (ffmpeg) parts.push('--ffmpeg-location', quote(ffmpeg))
    parts.push('>', quote(log), '2>&1')
    return parts.join(' ')
  }

  private async readLog(job: JobRecord, log: string): Promise<void> {
    let source: string
    try {
      source = await readFile(log, 'utf8')
    } catch {
      return
    }
    if (job.state !== 'running') return
    const lines = source.split(/\r?\n/).filter((line) => line.length > 0)
    for (const line of lines) {
      const parsed = parseProgressLine(line)
      if (!parsed) continue
      job.percent = parsed.percent
      job.downloadedBytes = parsed.downloadedBytes
      job.totalBytes = parsed.totalBytes
      job.speedBytesPerSecond = parsed.speedBytesPerSecond
      job.etaSeconds = parsed.etaSeconds
    }
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('ERROR:')) job.message = trimmed
      if (trimmed.startsWith('[') || trimmed.startsWith('WARNING')) continue
      if (/^(?:[A-Za-z]:[\\/]|\/)/.test(trimmed)) job.filePath = trimmed
    }
    const destinations = [...source.matchAll(/^\[download\] Destination: (.+)$/gm)]
    const destination = destinations
      .at(-1)?.[1]
      ?.trim()
      .replace(/\.f\d+(?=\.[^.]+$)/, '')
    if (job.filePath !== null) job.title = titleFromPath(job.filePath)
    else if (destination !== undefined) job.title = titleFromPath(destination)
    this.emit(job)
  }

  private transition(job: JobRecord, state: MediaDownloadState, message: string | null): void {
    if (TERMINAL.includes(job.state)) return
    job.state = state
    job.message = message
    this.emit(job)
    if (TERMINAL.includes(state)) job.resolve(this.snapshot(job))
  }

  private finish(job: JobRecord, state: MediaDownloadState, message: string | null): void {
    this.transition(job, state, message)
  }

  private require(jobId: string): JobRecord {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`unknown download job: ${jobId}`)
    return job
  }

  private progress(job: JobRecord): MediaDownloadProgress {
    return {
      jobId: job.id,
      state: job.state,
      percent: job.percent,
      downloadedBytes: job.downloadedBytes,
      totalBytes: job.totalBytes,
      speedBytesPerSecond: job.speedBytesPerSecond,
      etaSeconds: job.etaSeconds,
      message: job.message
    }
  }

  private snapshot(job: JobRecord): MediaDownloadJob {
    return {
      ...this.progress(job),
      url: job.request.url,
      title: job.title,
      filePath: job.filePath
    }
  }

  private emit(job: JobRecord): void {
    const progress = this.progress(job)
    for (const listener of this.listeners) {
      try {
        listener(progress)
      } catch {
        /* A subscriber must not interrupt the job. */
      }
    }
  }
}

function summarize(stderr: string): string | null {
  const line = stderr
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .at(-1)
  return line === undefined ? null : line
}

function titleFromPath(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '')
}
