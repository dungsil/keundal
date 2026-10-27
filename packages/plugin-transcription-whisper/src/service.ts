import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

import type { ExecutionOptions } from '@keundal/core'
import type { MediaToolsService } from '@keundal/media'
import type { ShellService } from '@keundal/shell'
import {
  MediaTranscriptionService,
  type SpeechModelProgress,
  type SpeechModelStatus,
  type TranscribeMediaRequest,
  type TranscribeMediaResult
} from '@keundal/transcription'
import type { Context } from 'cordis'

import { defaultSpeechModel, findSpeechModel, speechModels } from './models.js'
import { parseWhisperJson } from './whisper.js'

export type WhisperFetch = (url: string, init: { readonly signal?: AbortSignal }) => Promise<Response>

export interface WhisperModelOptions extends ExecutionOptions {
  readonly onProgress?: (progress: SpeechModelProgress) => void
}

export interface WhisperConfig {
  /** 모델 파일과 설정을 저장하는 앱 데이터 디렉터리입니다. */
  readonly dataDir: string
  /** `whisper.cpp` 실행 파일 경로입니다. 생략하면 `whisper-cli`를 `PATH`에서 찾습니다. */
  readonly executable?: string
  readonly model?: string
  /** 추론 스레드 수입니다. 기본값은 4입니다. */
  readonly threads?: number
  /** 오디오 임시 파일을 둘 디렉터리입니다. 생략하면 시스템 임시 디렉터리를 씁니다. */
  readonly workDirectory?: string
  readonly fetch?: WhisperFetch
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function quote(value: string): string {
  if (process.platform !== 'win32') return `'${value.replace(/'/g, `'\\''`)}'`
  // cmd.exe는 역슬래시를 이스케이프로 쓰지 않으므로, 인용문자가 든 값은 받지 않습니다.
  if (/["%!\r\n]/.test(value)) throw new TypeError('value contains unsafe cmd.exe characters')
  return `"${value}"`
}

function summarize(stderr: string, tool: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .at(-1)
  return line === undefined ? `${tool} failed` : `${tool}: ${line}`
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** whisper.cpp로 로컬 파일을 전사합니다. 오디오 추출은 `ffmpeg`와 `ShellService`가 맡습니다. */
export class WhisperTranscriptionService extends MediaTranscriptionService {
  private readonly shell: ShellService
  private readonly tools: MediaToolsService
  private readonly dataDir: string
  private readonly executable: string
  private readonly model: string
  private readonly threads: number
  private readonly workDirectory: string
  private readonly fetchModel: WhisperFetch
  private readonly lifetime = new globalThis.AbortController()
  private readonly installing = new Set<string>()

  constructor(ctx: Context, config: WhisperConfig) {
    super(ctx)
    if (!config || requireText(config.dataDir, 'dataDir').length === 0) throw new TypeError('dataDir is required')
    if (config.executable !== undefined && !isAbsolute(config.executable)) {
      throw new TypeError('executable must be an absolute path')
    }
    if (config.threads !== undefined && (!Number.isSafeInteger(config.threads) || config.threads < 1)) {
      throw new TypeError('threads must be a positive integer')
    }
    this.shell = ctx.shell
    this.tools = ctx.mediaTools
    this.dataDir = resolve(config.dataDir)
    this.executable = config.executable ?? 'whisper-cli'
    this.model = config.model ?? defaultSpeechModel
    if (!findSpeechModel(this.model)) throw new Error(`unknown speech model: ${this.model}`)
    this.threads = config.threads ?? 4
    this.workDirectory = resolve(config.workDirectory ?? tmpdir())
    this.fetchModel = config.fetch ?? ((url, init) => globalThis.fetch(url, { signal: init.signal }))
    ctx.fiber.effect(() => () => this.lifetime.abort())
  }

  async models(options: ExecutionOptions = {}): Promise<readonly SpeechModelStatus[]> {
    options = this.options(options)
    const statuses: SpeechModelStatus[] = []
    for (const model of speechModels) {
      options.signal?.throwIfAborted()
      const path = this.modelPath(model.id)
      statuses.push({ ...model, installed: await isFile(path), path })
    }
    return statuses
  }

  async installModel(request: { readonly id: string }, options: WhisperModelOptions = {}): Promise<SpeechModelStatus> {
    options = this.options(options)
    options.signal?.throwIfAborted()
    const id = requireText(request?.id, 'id')
    const model = findSpeechModel(id)
    if (!model) throw new Error(`unknown speech model: ${id}`)
    if (this.installing.has(id)) throw new Error(`${id} is already being installed`)
    this.installing.add(id)
    const path = this.modelPath(id)
    const temporary = `${path}.${randomUUID()}.part`
    try {
      await mkdir(this.modelsDirectory(), { recursive: true })
      const response = await this.fetchModel(model.url, { signal: options.signal })
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
      await this.download(id, response, temporary, options)
      options.signal?.throwIfAborted()
      await rename(temporary, path)
      return { ...model, installed: true, path }
    } finally {
      this.installing.delete(id)
      await rm(temporary, { force: true })
    }
  }

  async transcribe(request: TranscribeMediaRequest, options: ExecutionOptions = {}): Promise<TranscribeMediaResult> {
    options = this.options(options)
    options.signal?.throwIfAborted()
    const filePath = resolve(requireText(request?.filePath, 'filePath'))
    const id = request.model === undefined ? this.model : requireText(request.model, 'model')
    if (!findSpeechModel(id)) throw new Error(`unknown speech model: ${id}`)
    const modelPath = this.modelPath(id)
    if (!(await isFile(modelPath))) throw new Error(`speech model ${id} is not installed`)
    const language = request.language == null ? null : requireText(request.language, 'language')
    if (language !== null && !/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(language))
      throw new TypeError('invalid language code')
    const directory = await mkdtemp(join(this.workDirectory, 'keundal-whisper-'))
    try {
      const audio = join(directory, 'audio.wav')
      const ffmpeg = await this.tools.resolve('ffmpeg', options)
      const extracted = await this.shell.execute(
        {
          command: [
            quote(ffmpeg),
            '-y',
            '-loglevel',
            'error',
            '-i',
            quote(filePath),
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'pcm_s16le',
            quote(audio)
          ].join(' ')
        },
        options
      )
      options.signal?.throwIfAborted()
      if (extracted.exitCode !== 0) throw new Error(summarize(extracted.stderr, 'ffmpeg'))
      const output = join(directory, 'result')
      const recognized = await this.shell.execute(
        {
          command: [
            quote(this.executable),
            '-m',
            quote(modelPath),
            '-f',
            quote(audio),
            '-ojf',
            '-of',
            quote(output),
            '-t',
            String(this.threads),
            '-l',
            language ?? 'auto'
          ].join(' ')
        },
        options
      )
      options.signal?.throwIfAborted()
      if (recognized.exitCode !== 0) throw new Error(summarize(recognized.stderr, 'whisper'))
      const parsed = parseWhisperJson(await readFile(`${output}.json`, 'utf8'))
      return {
        model: id,
        language: parsed.language ?? language,
        segments: parsed.segments,
        words: parsed.words
      }
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private modelsDirectory(): string {
    return join(this.dataDir, 'models')
  }

  private options<T extends ExecutionOptions>(options: T): T {
    return {
      ...options,
      signal: globalThis.AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])])
    }
  }

  private modelPath(id: string): string {
    return join(this.modelsDirectory(), `ggml-${id}.bin`)
  }

  private async download(id: string, response: Response, path: string, options: WhisperModelOptions): Promise<void> {
    const total = Number(response.headers.get('content-length') ?? Number.NaN)
    const totalBytes = Number.isFinite(total) && total > 0 ? total : null
    if (!response.body) throw new Error('download has no response body')
    const file = await open(path, 'wx')
    const reader = response.body.getReader()
    const abort = () => {
      void reader.cancel(options.signal?.reason).catch(() => undefined)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    let downloaded = 0
    try {
      for (;;) {
        options.signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        await file.writeFile(value)
        downloaded += value.byteLength
        options.onProgress?.({ id, downloadedBytes: downloaded, totalBytes })
      }
      options.signal?.throwIfAborted()
      if (downloaded === 0 || (totalBytes !== null && downloaded !== totalBytes)) throw new Error('incomplete download')
    } finally {
      options.signal?.removeEventListener('abort', abort)
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      await file.close()
    }
  }
}
