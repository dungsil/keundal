import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { ExecutionOptions } from '@keundal/core'
import {
  MediaToolsService,
  type ConfigureMediaToolRequest,
  type InstallMediaToolRequest,
  type MediaToolName,
  type MediaToolStatus
} from '@keundal/media'
import localMediaDownloadPlugin, { LocalMediaDownloadService, parseProgressLine } from '@keundal/plugin-media-download'
import { ShellService, type ShellRequest, type ShellResult } from '@keundal/shell'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

function result(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    truncated: false,
    ...overrides
  }
}

class FakeShell extends ShellService {
  readonly commands: string[] = []
  handler: (command: string, options: ExecutionOptions) => Promise<ShellResult> = async () => result()

  constructor(ctx: Context) {
    super(ctx)
  }

  async execute(request: ShellRequest, options: ExecutionOptions = {}): Promise<ShellResult> {
    this.commands.push(request.command)
    return this.handler(request.command, options)
  }
}

class FakeTools extends MediaToolsService {
  readonly missing = new Set<MediaToolName>(['ffmpeg'])

  async status(): Promise<readonly MediaToolStatus[]> {
    return []
  }

  async resolve(name: MediaToolName): Promise<string> {
    if (this.missing.has(name)) throw new Error(`${name} was not found`)
    return name === 'yt-dlp'
      ? process.platform === 'win32'
        ? 'C:\\tools\\yt-dlp.exe'
        : '/tools/yt-dlp'
      : process.platform === 'win32'
        ? 'C:\\tools\\ffmpeg.exe'
        : '/tools/ffmpeg'
  }

  async install(request: InstallMediaToolRequest): Promise<MediaToolStatus> {
    return { name: request.name, installed: true, path: null, version: null, source: 'installed' }
  }

  async configure(_request: ConfigureMediaToolRequest): Promise<void> {}
}

const shellPlugin = Object.assign(
  function fakeShellPlugin(ctx: Context) {
    new FakeShell(ctx)
  },
  { inject: [] as string[] }
)

const toolsPlugin = Object.assign(
  function fakeToolsPlugin(ctx: Context) {
    new FakeTools(ctx)
  },
  { inject: [] as string[] }
)

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'keundal-download-'))
  const ctx = new Context()
  await ctx.plugin(shellPlugin)
  await ctx.plugin(toolsPlugin)
  const provider = await ctx.plugin(localMediaDownloadPlugin, { workDirectory: join(dir, 'work'), pollMs: 10 })
  t.onTestFinished(async () => {
    await provider.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { ctx, dir, provider, shell: ctx.shell as FakeShell }
}

function logPath(command: string): string {
  // Windows는 따옴표를 두 개, POSIX는 하나로 인용합니다.
  const matched = / > (["'])(.+?)\1[ \t]*2>&1$/.exec(command)
  if (!matched) throw new Error(`log path is missing: ${command}`)
  return matched[2]!
}

const destination = process.platform === 'win32' ? 'C:\\out\\첫 영상.mp4' : '/out/첫 영상.mp4'

async function complete(command: string): Promise<ShellResult> {
  await writeFile(
    logPath(command),
    [
      '[download] Destination: 첫 영상.f137.mp4',
      '[download]  10.0% of ~  10.00MiB at 1.00MiB/s ETA 00:09',
      '[download] 100.0% of ~  10.00MiB at 1.00MiB/s ETA 00:00',
      destination,
      ''
    ].join('\n')
  )
  return result()
}

test('yt-dlp 진행 줄을 퍼센트, 크기, 속도, 남은 시간으로 해석한다', () => {
  expect(parseProgressLine('[download]  12.3% of ~ 100.00MiB at 1.00MiB/s ETA 00:12')).toEqual({
    percent: 12.3,
    downloadedBytes: Math.round((100 * 1024 * 1024 * 12.3) / 100),
    totalBytes: 100 * 1024 * 1024,
    speedBytesPerSecond: 1024 * 1024,
    etaSeconds: 12
  })
  expect(parseProgressLine('[download] Destination: clip.mp4')).toBeNull()
})

test('링크를 큐에 넣으면 완료 상태와 저장 경로를 남긴다', async (t) => {
  const { ctx, shell, dir } = await setup(t)
  expect(ctx.mediaDownload).toBeInstanceOf(LocalMediaDownloadService)
  ;(ctx.mediaTools as FakeTools).missing.clear()
  shell.handler = complete
  const job = await ctx.mediaDownload.start({ url: 'https://example.com/watch?v=1', outputDirectory: dir })
  expect(job.state).toBe('queued')
  const finished = await ctx.mediaDownload.wait(job.jobId)
  expect(finished.state).toBe('completed')
  expect(finished.percent).toBe(100)
  expect(finished.filePath).toBe(destination)
  expect(finished.title).toBe('첫 영상')
  const command = shell.commands[0]!
  expect(command).toContain('--merge-output-format mp4')
  expect(command).toContain('--ffmpeg-location')
  expect(command).toContain('--newline')
})

test('오디오 형식은 음원 추출 인자를 붙이고 ffmpeg가 없어도 실행한다', async (t) => {
  const { ctx, shell, dir } = await setup(t)
  shell.handler = complete
  const job = await ctx.mediaDownload.start({
    url: 'https://example.com/watch?v=2',
    outputDirectory: dir,
    format: 'audio'
  })
  await ctx.mediaDownload.wait(job.jobId)
  const command = shell.commands[0]!
  expect(command).toContain('--extract-audio')
  expect(command).toContain('m4a')
  expect(command).not.toContain('--ffmpeg-location')
})

test('내장 자막과 브라우저 쿠키를 요청하면 해당 인자를 붙인다', async (t) => {
  const { ctx, shell, dir } = await setup(t)
  shell.handler = complete
  const job = await ctx.mediaDownload.start({
    url: 'https://example.com/watch?v=3',
    outputDirectory: dir,
    subtitles: 'builtin',
    cookiesFromBrowser: 'chrome'
  })
  await ctx.mediaDownload.wait(job.jobId)
  const command = shell.commands[0]!
  expect(command).toContain('--write-subs')
  expect(command).toContain('--cookies-from-browser')
  expect(command).toContain('chrome')
})

test('실패한 작업은 마지막 오류 줄을 남기고 실패 상태가 된다', async (t) => {
  const { ctx, shell, dir } = await setup(t)
  shell.handler = async () => result({ exitCode: 1, stderr: 'ERROR: Unsupported URL' })
  const job = await ctx.mediaDownload.start({ url: 'https://example.com/bad', outputDirectory: dir })
  const finished = await ctx.mediaDownload.wait(job.jobId)
  expect(finished.state).toBe('failed')
  expect(finished.message).toBe('ERROR: Unsupported URL')
})

test('셸 리다이렉션으로 로그에만 남은 오류도 작업에 보존한다', async (t) => {
  const { ctx, shell, dir } = await setup(t)
  shell.handler = async (command) => {
    await writeFile(logPath(command), 'ERROR: Unable to download webpage\n')
    return result({ exitCode: 1 })
  }
  const job = await ctx.mediaDownload.start({ url: 'https://example.com/bad', outputDirectory: dir })
  expect((await ctx.mediaDownload.wait(job.jobId)).message).toBe('ERROR: Unable to download webpage')
})

test('일시정지한 작업은 paused로 남고 재개하면 다시 완료된다', async (t) => {
  const { ctx, shell, dir } = await setup(t)
  shell.handler = async (_command, options) => {
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    return result({ exitCode: null, aborted: true })
  }
  const job = await ctx.mediaDownload.start({ url: 'https://example.com/watch?v=4', outputDirectory: dir })
  await delay(30)
  await ctx.mediaDownload.pause(job.jobId)
  await delay(30)
  expect(ctx.mediaDownload.list()[0]!.state).toBe('paused')
  shell.handler = complete
  await ctx.mediaDownload.resume(job.jobId)
  const finished = await ctx.mediaDownload.wait(job.jobId)
  expect(finished.state).toBe('completed')
  expect(shell.commands).toHaveLength(2)
  expect(shell.commands[1]).toContain('--continue')
})

test('취소한 작업은 cancelled가 되고 구독자에게 상태를 전달한다', async (t) => {
  const { ctx, shell, dir } = await setup(t)
  shell.handler = async (_command, options) => {
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    return result({ aborted: true })
  }
  const states: string[] = []
  const unsubscribe = ctx.mediaDownload.subscribe((progress) => states.push(progress.state))
  const job = await ctx.mediaDownload.start({ url: 'https://example.com/watch?v=5', outputDirectory: dir })
  await delay(30)
  await ctx.mediaDownload.cancel(job.jobId)
  const finished = await ctx.mediaDownload.wait(job.jobId)
  unsubscribe()
  expect(finished.state).toBe('cancelled')
  expect(states).toContain('queued')
  expect(states).toContain('running')
  expect(states.at(-1)).toBe('cancelled')
})

test('http 링크가 아니면 작업을 만들지 않는다', async (t) => {
  const { ctx, dir } = await setup(t)
  await expect(ctx.mediaDownload.start({ url: 'ftp://example.com/a', outputDirectory: dir })).rejects.toThrow(
    'http or https'
  )
  expect(ctx.mediaDownload.list()).toHaveLength(0)
})

test('실행을 시작하기 전에 취소하면 프로세스를 만들지 않는다', async (t) => {
  const { ctx, dir, shell } = await setup(t)
  const service = ctx.mediaDownload
  service.subscribe((progress) => {
    if (progress.state === 'queued') void service.cancel(progress.jobId)
  })
  const job = await service.start({ url: 'https://example.com/a', outputDirectory: dir })
  expect((await service.wait(job.jobId)).state).toBe('cancelled')
  await delay(5)
  expect(shell.commands).toHaveLength(0)
})

test('일시정지 직후 재개해도 이전 프로세스와 겹치지 않는다', async (t) => {
  const { ctx, dir, shell } = await setup(t)
  const started = Promise.withResolvers<void>()
  let active = 0
  let peak = 0
  shell.handler = async (command, options) => {
    active += 1
    peak = Math.max(peak, active)
    try {
      if (shell.commands.length > 1) return await complete(command)
      started.resolve()
      await new Promise<void>((resolve) => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
      await delay(10)
      return result({ aborted: true })
    } finally {
      active -= 1
    }
  }
  const job = await ctx.mediaDownload.start({ url: 'https://example.com/a', outputDirectory: dir })
  await started.promise
  const paused = ctx.mediaDownload.pause(job.jobId)
  await ctx.mediaDownload.resume(job.jobId)
  await paused
  expect((await ctx.mediaDownload.wait(job.jobId)).state).toBe('completed')
  expect(peak).toBe(1)
})

test('플러그인을 해제하면 대기자가 cancelled를 받고 실행도 끝난다', async (t) => {
  const { ctx, dir, shell, provider } = await setup(t)
  const service = ctx.mediaDownload
  const started = Promise.withResolvers<void>()
  let stopped = false
  shell.handler = async (_command, options) => {
    started.resolve()
    await new Promise<void>((resolve) => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
    stopped = true
    return result({ aborted: true })
  }
  const job = await service.start({ url: 'https://example.com/a', outputDirectory: dir })
  const waiting = service.wait(job.jobId)
  await started.promise
  await provider.dispose()
  expect((await waiting).state).toBe('cancelled')
  expect(stopped).toBe(true)
  await expect(service.resume(job.jobId)).rejects.toThrow('disposed')
})

test('이미 취소된 대기 신호는 즉시 거부하고 작업은 계속 실행한다', async (t) => {
  const { ctx, dir, shell } = await setup(t)
  shell.handler = complete
  const job = await ctx.mediaDownload.start({ url: 'https://example.com/a', outputDirectory: dir })
  await expect(ctx.mediaDownload.wait(job.jobId, { signal: AbortSignal.abort() })).rejects.toThrow()
  expect((await ctx.mediaDownload.wait(job.jobId)).state).toBe('completed')
})

test('작업을 큐에 넣은 뒤 POST 요청 신호가 취소되어도 작업은 완료된다', async (t) => {
  const { ctx, dir, shell } = await setup(t)
  const controller = new AbortController()
  shell.handler = complete
  const job = await ctx.mediaDownload.start(
    { url: 'https://example.com/a', outputDirectory: dir },
    { signal: controller.signal }
  )
  controller.abort()
  expect((await ctx.mediaDownload.wait(job.jobId)).state).toBe('completed')
})

test('구독자 오류와 구독 취소는 내려받기 완료를 방해하지 않는다', async (t) => {
  const { ctx, dir, shell } = await setup(t)
  shell.handler = complete
  ctx.mediaDownload.subscribe(() => {
    throw new Error('subscriber failed')
  })
  const controller = new AbortController()
  const states: string[] = []
  ctx.mediaDownload.subscribe((progress) => states.push(progress.state), { signal: controller.signal })
  controller.abort()
  const job = await ctx.mediaDownload.start({ url: 'https://example.com/a', outputDirectory: dir })
  expect((await ctx.mediaDownload.wait(job.jobId)).state).toBe('completed')
  expect(states).toEqual([])
})
