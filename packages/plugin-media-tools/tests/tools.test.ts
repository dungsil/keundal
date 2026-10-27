import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExecutionOptions } from '@keundal/core'
import localMediaToolsPlugin, { LocalMediaToolsService } from '@keundal/plugin-media-tools'
import { ShellService, type ShellRequest, type ShellResult } from '@keundal/shell'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

class FakeShell extends ShellService {
  readonly commands: string[] = []
  version = '2024.10.1'
  systemPath: string | null = null

  constructor(ctx: Context) {
    super(ctx)
  }

  async execute(request: ShellRequest, _options: ExecutionOptions = {}): Promise<ShellResult> {
    this.commands.push(request.command)
    if (request.command.includes('--version')) {
      return result({ stdout: `${this.version}\n` })
    }
    return result({
      stdout: this.systemPath === null ? '' : `${this.systemPath}\n`,
      exitCode: this.systemPath === null ? 1 : 0
    })
  }
}

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

const shellPlugin = Object.assign(
  function fakeShellPlugin(ctx: Context) {
    new FakeShell(ctx)
  },
  { inject: [] as string[] }
)

async function setup(t: TestContext, config: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'keundal-tools-'))
  const ctx = new Context()
  await ctx.plugin(shellPlugin)
  const provider = await ctx.plugin(localMediaToolsPlugin, { dataDir: dir, ...config })
  t.onTestFinished(async () => {
    await provider.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { ctx, dir, shell: ctx.shell as FakeShell }
}

test('설치된 도구가 없으면 상태를 missing으로 보고한다', async (t) => {
  const { ctx } = await setup(t)
  expect(ctx.mediaTools).toBeInstanceOf(LocalMediaToolsService)
  const statuses = await ctx.mediaTools.status()
  expect(statuses.map((status) => status.name)).toEqual(['yt-dlp', 'ffmpeg'])
  expect(statuses.every((status) => !status.installed && status.path === null)).toBe(true)
  await expect(ctx.mediaTools.resolve('yt-dlp')).rejects.toThrow('was not found')
})

test('시스템 경로에서 찾은 도구는 system으로 보고하고 버전을 붙인다', async (t) => {
  const { ctx, shell } = await setup(t)
  shell.systemPath = process.platform === 'win32' ? 'C:\\tools\\yt-dlp.exe' : '/usr/local/bin/yt-dlp'
  const statuses = await ctx.mediaTools.status()
  const ytdlp = statuses.find((status) => status.name === 'yt-dlp')!
  expect(ytdlp.installed).toBe(true)
  expect(ytdlp.source).toBe('system')
  expect(ytdlp.path).toBe(shell.systemPath)
  expect(ytdlp.version).toBe('2024.10.1')
})

test('내려받아 설치하면 앱 데이터 폴더에 실행 파일을 만들고 진행률을 알린다', async (t) => {
  const progress: number[] = []
  const { ctx, dir } = await setup(t, {
    fetch: async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-length': '4' }
      })
  })
  const status = await ctx.mediaTools.install(
    { name: 'yt-dlp' },
    {
      onProgress: (value) => progress.push(value.downloadedBytes)
    }
  )
  expect(status.installed).toBe(true)
  expect(status.source).toBe('installed')
  expect(status.path).toBe(join(dir, 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'))
  expect(await readFile(status.path!)).toHaveLength(4)
  expect(progress.at(-1)).toBe(4)
  expect((await ctx.mediaTools.status()).find((entry) => entry.name === 'yt-dlp')!.path).toBe(status.path)
})

test('ffmpeg는 기본 내려받기 주소가 없어 설치를 거부한다', async (t) => {
  const { ctx } = await setup(t)
  await expect(ctx.mediaTools.install({ name: 'ffmpeg' })).rejects.toThrow('no download source')
})

test('직접 지정한 경로를 먼저 쓰고, 해제하면 기본 탐색으로 돌아간다', async (t) => {
  const { ctx } = await setup(t)
  const configured = process.platform === 'win32' ? 'C:\\custom\\yt-dlp.exe' : '/opt/custom/yt-dlp'
  await ctx.mediaTools.configure({ name: 'yt-dlp', path: configured })
  const found = (await ctx.mediaTools.status()).find((status) => status.name === 'yt-dlp')!
  expect(found.source).toBe('configured')
  expect(found.path).toBe(configured)
  await expect(ctx.mediaTools.resolve('yt-dlp')).resolves.toBe(configured)
  await ctx.mediaTools.configure({ name: 'yt-dlp', path: null })
  expect((await ctx.mediaTools.status()).find((status) => status.name === 'yt-dlp')!.source).toBeNull()
})

test('상대 경로는 직접 지정으로 받지 않는다', async (t) => {
  const { ctx } = await setup(t)
  await expect(ctx.mediaTools.configure({ name: 'yt-dlp', path: 'tools/yt-dlp' })).rejects.toThrow('absolute')
})
