import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

import type { ExecutionOptions } from '@keundal/core'
import {
  MediaToolsService,
  type ConfigureMediaToolRequest,
  type InstallMediaToolRequest,
  type MediaToolName,
  type MediaToolOptions,
  type MediaToolSource,
  type MediaToolStatus
} from '@keundal/media'
import type { ShellService } from '@keundal/shell'
import type { Context } from 'cordis'

const CONFIG_MANIFEST = 'media-tools.json'
const TOOLS_DIRECTORY = 'tools'
const CONFIG_VERSION = 1
const TOOL_NAMES: readonly MediaToolName[] = ['yt-dlp', 'ffmpeg']

const DEFAULT_SOURCES: Readonly<Partial<Record<MediaToolName, string>>> = {
  'yt-dlp':
    process.platform === 'win32'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : process.platform === 'darwin'
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
}

export type MediaToolFetch = (url: string, init: { readonly signal?: AbortSignal }) => Promise<Response>

export interface MediaToolsConfig {
  /** 실행 파일과 설정을 저장하는 앱 데이터 디렉터리입니다. */
  readonly dataDir: string
  /** 도구별 내려받기 주소를 바꿉니다. `ffmpeg`는 기본 주소가 없습니다. */
  readonly sources?: Readonly<Partial<Record<MediaToolName, string>>>
  readonly fetch?: MediaToolFetch
  /** `PATH` 탐색에 쓰는 명령입니다. 테스트에서 실제 프로세스를 피하려고 바꿉니다. */
  readonly lookupCommands?: Readonly<Record<'posix' | 'win32', readonly [string, string]>>
}

interface ToolsConfig {
  readonly version: number
  readonly paths: Readonly<Record<string, string>>
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function requireToolName(value: unknown): MediaToolName {
  if (value !== 'yt-dlp' && value !== 'ffmpeg') throw new TypeError('name must be yt-dlp or ffmpeg')
  return value
}

function executableName(name: MediaToolName): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function parseVersion(name: MediaToolName, result: { stdout: string; stderr: string }): string | null {
  const text = `${result.stdout}\n${result.stderr}`.trim()
  if (text.length === 0) return null
  if (name === 'ffmpeg') {
    const matched = /ffmpeg version (\S+)/i.exec(text)
    return matched ? matched[1]! : null
  }
  const first = text.split(/\r?\n/, 1)[0]!.trim()
  return first.length > 0 ? first : null
}

export class LocalMediaToolsService extends MediaToolsService {
  private readonly shell: ShellService
  private readonly dataDir: string
  private readonly sources: Readonly<Partial<Record<MediaToolName, string>>>
  private readonly fetchTool: MediaToolFetch
  private readonly lookupCommands: Readonly<Record<'posix' | 'win32', readonly [string, string]>>
  private readonly installing = new Set<MediaToolName>()
  private configuring: Promise<void> = Promise.resolve()
  private readonly lifetime = new globalThis.AbortController()

  constructor(ctx: Context, config: MediaToolsConfig) {
    super(ctx)
    if (!config || requireText(config.dataDir, 'dataDir').length === 0) throw new TypeError('dataDir is required')
    this.shell = ctx.shell
    this.dataDir = resolve(config.dataDir)
    this.sources = { ...DEFAULT_SOURCES, ...config.sources }
    this.fetchTool = config.fetch ?? ((url, init) => globalThis.fetch(url, { signal: init.signal }))
    this.lookupCommands = config.lookupCommands ?? {
      posix: ['command -v', ''],
      win32: ['where', '']
    }
    ctx.fiber.effect(() => () => this.lifetime.abort())
  }

  async status(options: ExecutionOptions = {}): Promise<readonly MediaToolStatus[]> {
    options = this.options(options)
    const statuses: MediaToolStatus[] = []
    for (const name of TOOL_NAMES) {
      options.signal?.throwIfAborted()
      const located = await this.locate(name, options)
      if (!located) {
        statuses.push({ name, installed: false, path: null, version: null, source: null })
        continue
      }
      const version = await this.version(name, located.path, options).catch(() => null)
      options.signal?.throwIfAborted()
      statuses.push({ name, installed: true, path: located.path, version, source: located.source })
    }
    return statuses
  }

  async resolve(name: MediaToolName, options: ExecutionOptions = {}): Promise<string> {
    options = this.options(options)
    options.signal?.throwIfAborted()
    const located = await this.locate(requireToolName(name), options)
    options.signal?.throwIfAborted()
    if (!located) throw new Error(`${name} was not found`)
    return located.path
  }

  async install(request: InstallMediaToolRequest, options: MediaToolOptions = {}): Promise<MediaToolStatus> {
    options = this.options(options)
    options.signal?.throwIfAborted()
    const name = requireToolName(request.name)
    if (this.installing.has(name)) throw new Error(`${name} is already being installed`)
    const source = this.sources[name]
    if (!source) throw new Error(`no download source is configured for ${name}`)
    this.installing.add(name)
    try {
      const target = join(this.toolsDirectory(), executableName(name))
      await mkdir(this.toolsDirectory(), { recursive: true })
      const response = await this.fetchTool(source, { signal: options.signal })
      if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
      const temporary = `${target}.${randomUUID()}.part`
      try {
        await this.download(name, response, temporary, options)
        if (process.platform !== 'win32') await chmod(temporary, 0o755)
        options.signal?.throwIfAborted()
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
      const version = await this.version(name, target, options).catch(() => null)
      options.signal?.throwIfAborted()
      return { name, installed: true, path: target, version, source: 'installed' }
    } finally {
      this.installing.delete(name)
    }
  }

  async configure(request: ConfigureMediaToolRequest, options: ExecutionOptions = {}): Promise<void> {
    options = this.options(options)
    options.signal?.throwIfAborted()
    const name = requireToolName(request.name)
    const path = request.path === null ? null : requireText(request.path, 'path')
    if (path !== null && !isAbsolute(path)) throw new TypeError('path must be absolute')
    const update = async () => {
      options.signal?.throwIfAborted()
      const config = await this.readConfig()
      const paths = { ...config.paths }
      if (path === null) delete paths[name]
      else paths[name] = path
      await mkdir(this.dataDir, { recursive: true })
      const temporary = join(this.dataDir, `.media-tools-${randomUUID()}.json`)
      try {
        await writeFile(temporary, `${JSON.stringify({ version: CONFIG_VERSION, paths }, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          signal: options.signal
        })
        options.signal?.throwIfAborted()
        await rename(temporary, join(this.dataDir, CONFIG_MANIFEST))
      } finally {
        await rm(temporary, { force: true })
      }
    }
    this.configuring = this.configuring.then(update, update)
    await this.configuring
  }

  private toolsDirectory(): string {
    return join(this.dataDir, TOOLS_DIRECTORY)
  }

  private options<T extends ExecutionOptions>(options: T): T {
    return {
      ...options,
      signal: globalThis.AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])])
    }
  }

  private async locate(
    name: MediaToolName,
    options: ExecutionOptions = {}
  ): Promise<{ path: string; source: MediaToolSource } | null> {
    const config = await this.readConfig()
    const configured = config.paths[name]
    if (configured !== undefined) return { path: configured, source: 'configured' }
    const installed = join(this.toolsDirectory(), executableName(name))
    if (await this.exists(installed)) return { path: installed, source: 'installed' }
    const [command, suffix] = this.lookupCommands[process.platform === 'win32' ? 'win32' : 'posix']
    const result = await this.shell.execute({ command: `${command} ${name}${suffix}` }, options)
    const found = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && isAbsolute(line))
    return found ? { path: found, source: 'system' } : null
  }

  private async version(name: MediaToolName, path: string, options: ExecutionOptions): Promise<string | null> {
    const result = await this.shell.execute({ command: `${quote(path)} --version` }, options)
    if (result.exitCode !== 0) return null
    return parseVersion(name, result)
  }

  private async download(
    name: MediaToolName,
    response: Response,
    path: string,
    options: MediaToolOptions
  ): Promise<void> {
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
        options.onProgress?.({ name, downloadedBytes: downloaded, totalBytes })
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

  private async readConfig(): Promise<ToolsConfig> {
    let source: string
    try {
      source = await readFile(join(this.dataDir, CONFIG_MANIFEST), 'utf8')
    } catch {
      return { version: CONFIG_VERSION, paths: {} }
    }
    try {
      const value = JSON.parse(source) as Record<string, unknown>
      const paths = value.paths
      if (typeof paths !== 'object' || paths === null) return { version: CONFIG_VERSION, paths: {} }
      const entries = Object.entries(paths as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
      return { version: CONFIG_VERSION, paths: Object.fromEntries(entries) }
    } catch {
      return { version: CONFIG_VERSION, paths: {} }
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  }
}

function quote(path: string): string {
  requireText(path, 'executable path')
  if (process.platform === 'win32' && /["%!\r\n]/.test(path)) throw new TypeError('unsafe cmd.exe path')
  return process.platform === 'win32' ? `"${path}"` : `'${path.replace(/'/g, `'\\''`)}'`
}
