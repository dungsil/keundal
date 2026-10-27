import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExecutionOptions } from '@keundal/core'
import {
  MediaLibraryService,
  MediaToolsService,
  type ConfigureMediaToolRequest,
  type InstallMediaToolRequest,
  type MediaItem,
  type MediaLibrary,
  type MediaToolName,
  type MediaToolStatus,
  type SubtitleTrack
} from '@keundal/media'
import localMediaExportPlugin, { LocalMediaExportService, buildAss, buildFcpxml } from '@keundal/plugin-media-export'
import { ShellService, type ShellRequest, type ShellResult } from '@keundal/shell'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const createdAt = '2026-10-26T00:00:00.000Z'

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

const track: SubtitleTrack = {
  id: 'original',
  kind: 'original',
  language: 'ko',
  segments: [
    { startMs: 1_000, endMs: 2_000, text: '첫 줄', speaker: null },
    { startMs: 3_500, endMs: 4_500, text: '둘째 줄', speaker: null }
  ]
}

class FakeShell extends ShellService {
  readonly commands: string[] = []
  handler: (command: string) => Promise<ShellResult> = async () => result()

  constructor(ctx: Context) {
    super(ctx)
  }

  async execute(request: ShellRequest, _options: ExecutionOptions = {}): Promise<ShellResult> {
    this.commands.push(request.command)
    return this.handler(request.command)
  }
}

class FakeTools extends MediaToolsService {
  async status(): Promise<readonly MediaToolStatus[]> {
    return []
  }

  async resolve(name: MediaToolName): Promise<string> {
    if (name !== 'ffmpeg') throw new Error(`${name} was not found`)
    return process.platform === 'win32' ? 'C:\\tools\\ffmpeg.exe' : '/tools/ffmpeg'
  }

  async install(request: InstallMediaToolRequest): Promise<MediaToolStatus> {
    return { name: request.name, installed: true, path: null, version: null, source: 'installed' }
  }

  async configure(_request: ConfigureMediaToolRequest): Promise<void> {}
}

class FakeLibrary extends MediaLibraryService {
  readonly item: MediaItem = {
    id: 'item-1',
    title: '첫 영상',
    createdAt,
    updatedAt: createdAt,
    storage: 'copy',
    origin: { kind: 'local', path: '/videos/clip.mp4' },
    video: { path: process.platform === 'win32' ? 'C:\\videos\\clip.mp4' : '/videos/clip.mp4', present: true },
    subtitleTracks: [track]
  }

  async create(): Promise<MediaLibrary> {
    throw new Error('unused')
  }

  async open(): Promise<MediaLibrary> {
    throw new Error('unused')
  }

  async list(): Promise<readonly MediaItem[]> {
    return [this.item]
  }

  async read(): Promise<MediaItem> {
    return this.item
  }

  async import(): Promise<readonly MediaItem[]> {
    return []
  }

  async remove(): Promise<void> {}

  async relocate(): Promise<MediaItem> {
    return this.item
  }

  async saveSubtitle(): Promise<void> {}
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

const libraryPlugin = Object.assign(
  function fakeLibraryPlugin(ctx: Context) {
    new FakeLibrary(ctx)
  },
  { inject: [] as string[] }
)

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'keundal-export-'))
  const ctx = new Context()
  await ctx.plugin(shellPlugin)
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(libraryPlugin)
  const provider = await ctx.plugin(localMediaExportPlugin, { workDirectory: directory })
  t.onTestFinished(async () => {
    await provider.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { ctx, directory, shell: ctx.shell as FakeShell }
}

test('ASS 자막은 클립 시작을 0으로 옮기고 범위 밖 줄을 버린다', () => {
  const document = buildAss(track.segments, 1_000)
  expect(document).toContain('PlayResX: 1280')
  expect(document).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,첫 줄')
  expect(document).toContain('Dialogue: 0,0:00:02.50,0:00:03.50,Default,,0,0,0,,둘째 줄')
  expect(buildAss(track.segments, 5_000)).not.toContain('Dialogue:')
})

test('FCPXML은 원본 자산과 클립 구간을 담는다', () => {
  const document = buildFcpxml({
    title: '첫 & 영상',
    sourceUrl: 'file:///videos/clip.mp4',
    clips: [
      { id: 'c1', name: '하나', startMs: 1_000, endMs: 3_000 },
      { id: 'c2', name: '둘', startMs: 4_000, endMs: 5_500 }
    ]
  })
  expect(document).toContain('<fcpxml version="1.9">')
  expect(document).toContain('name="첫 &amp; 영상"')
  expect(document).toContain('src="file:///videos/clip.mp4"')
  expect(document).toContain('offset="0.000s" duration="2.000s" start="1.000s"')
  expect(document).toContain('offset="2.000s" duration="1.500s" start="4.000s"')
  expect(document).toContain('duration="3.500s"')
})

test('클립마다 ffmpeg를 실행하고 만든 파일을 돌려준다', async (t) => {
  const { ctx, directory, shell } = await setup(t)
  expect(ctx.mediaExport).toBeInstanceOf(LocalMediaExportService)
  const files = await ctx.mediaExport.clips({
    libraryPath: '/libraries/one',
    itemId: 'item-1',
    outputDirectory: join(directory, 'out'),
    clips: [
      { id: 'c1', name: '하나', startMs: 1_000, endMs: 3_000 },
      { id: 'c2', name: '하나', startMs: 4_000, endMs: 5_500 }
    ]
  })
  expect(files.map((file) => file.name)).toEqual(['하나', '하나-2'])
  expect(files[1]!.path).toBe(join(directory, 'out', '하나-2.mp4'))
  expect(shell.commands).toHaveLength(2)
  expect(shell.commands[0]).toContain('-ss 1.000')
  expect(shell.commands[0]).toContain('-t 2.000')
  expect(shell.commands[0]).toContain('-c:v libx264')
})

test('자막 번인은 자막 파일을 만들고 필터에 넣는다', async (t) => {
  const { ctx, directory, shell } = await setup(t)
  await ctx.mediaExport.clips({
    libraryPath: '/libraries/one',
    itemId: 'item-1',
    outputDirectory: join(directory, 'out'),
    clips: [{ id: 'c1', name: '하나', startMs: 1_000, endMs: 3_000 }],
    burnSubtitles: true,
    trackId: 'original'
  })
  expect(shell.commands[0]).toContain('subtitles=filename=')
  expect(shell.commands[0]).toContain('.ass')
})

test('자막 번인에 트랙을 지정하지 않으면 거부한다', async (t) => {
  const { ctx, directory } = await setup(t)
  await expect(
    ctx.mediaExport.clips({
      libraryPath: '/libraries/one',
      itemId: 'item-1',
      outputDirectory: join(directory, 'out'),
      clips: [{ id: 'c1', name: '하나', startMs: 0, endMs: 1_000 }],
      burnSubtitles: true
    })
  ).rejects.toThrow('trackId')
})

test('워터마크 문자열은 drawtext 필터로 들어간다', async (t) => {
  const { ctx, directory, shell } = await setup(t)
  await ctx.mediaExport.clips({
    libraryPath: '/libraries/one',
    itemId: 'item-1',
    outputDirectory: join(directory, 'out'),
    clips: [{ id: 'c1', name: '하나', startMs: 0, endMs: 1_000 }],
    watermark: 'keundal'
  })
  expect(shell.commands[0]).toContain('drawtext=text=')
  expect(shell.commands[0]).toContain('keundal')
})

test('ffmpeg가 실패하면 마지막 오류 줄을 담아 실패한다', async (t) => {
  const { ctx, directory, shell } = await setup(t)
  shell.handler = async () => result({ exitCode: 1, stderr: 'Invalid data found when processing input' })
  await expect(
    ctx.mediaExport.clips({
      libraryPath: '/libraries/one',
      itemId: 'item-1',
      outputDirectory: join(directory, 'out'),
      clips: [{ id: 'c1', name: '하나', startMs: 0, endMs: 1_000 }]
    })
  ).rejects.toThrow('Invalid data found')
})

test('FCPXML을 파일로 쓰고 클립 수를 돌려준다', async (t) => {
  const { ctx, directory } = await setup(t)
  const outputPath = join(directory, 'out', 'clips.fcpxml')
  const written = await ctx.mediaExport.fcpxml({
    libraryPath: '/libraries/one',
    itemId: 'item-1',
    outputPath,
    clips: [{ id: 'c1', name: '하나', startMs: 1_000, endMs: 3_000 }]
  })
  expect(written).toEqual({ path: outputPath, clipCount: 1 })
  const document = await readFile(outputPath, 'utf8')
  expect(document).toContain('<fcpxml version="1.9">')
  expect(document).toContain('name="첫 영상"')
})
