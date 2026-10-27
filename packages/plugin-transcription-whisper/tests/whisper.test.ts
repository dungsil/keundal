import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExecutionOptions } from '@keundal/core'
import {
  MediaToolsService,
  type ConfigureMediaToolRequest,
  type InstallMediaToolRequest,
  type MediaToolName,
  type MediaToolStatus
} from '@keundal/media'
import whisperTranscriptionPlugin, {
  WhisperTranscriptionService,
  parseWhisperJson,
  speechModels
} from '@keundal/plugin-transcription-whisper'
import { ShellService, type ShellRequest, type ShellResult } from '@keundal/shell'
import { MediaTranscriptionService } from '@keundal/transcription'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const modelId = 'large-v3-turbo-q5_0'

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

const fixture = JSON.stringify({
  result: { language: 'ko' },
  transcription: [
    {
      offsets: { from: 0, to: 1_500 },
      text: ' 안녕하세요 여러분',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
        { text: ' 안녕', offsets: { from: 0, to: 600 } },
        { text: '하세요', offsets: { from: 600, to: 1_100 } },
        { text: ' 여러분', offsets: { from: 1_100, to: 1_500 } }
      ]
    }
  ]
})

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

async function setup(t: TestContext, config: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'keundal-whisper-'))
  const ctx = new Context()
  await ctx.plugin(shellPlugin)
  await ctx.plugin(toolsPlugin)
  const provider = await ctx.plugin(whisperTranscriptionPlugin, {
    dataDir: directory,
    workDirectory: directory,
    ...config
  })
  t.onTestFinished(async () => {
    await provider.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { ctx, directory, provider, shell: ctx.shell as FakeShell }
}

/** 테스트에서 내려받기 없이 모델 파일만 준비합니다. */
async function placeModel(directory: string): Promise<void> {
  await mkdir(join(directory, 'models'), { recursive: true })
  await writeFile(join(directory, 'models', `ggml-${modelId}.bin`), new Uint8Array([1]))
}

function whisperOutputPath(command: string): string {
  const matched = / -of (["'])(.+?)\1/.exec(command)
  if (!matched) throw new Error(`whisper output path is missing: ${command}`)
  return matched[2]!
}

function respondWithFixture(shell: FakeShell): void {
  shell.handler = async (command) => {
    if (command.includes('-c:a pcm_s16le')) return result()
    await writeFile(`${whisperOutputPath(command)}.json`, fixture)
    return result()
  }
}

test('모델 목록은 설치 여부와 저장 경로를 함께 돌려준다', async (t) => {
  const { ctx, directory } = await setup(t)
  expect(ctx.mediaTranscription).toBeInstanceOf(WhisperTranscriptionService)
  expect(ctx.mediaTranscription).toBeInstanceOf(MediaTranscriptionService)
  const models = await ctx.mediaTranscription.models()
  expect(models.map((model) => model.id)).toEqual(speechModels.map((model) => model.id))
  expect(models.every((model) => !model.installed)).toBe(true)
  expect(models[0]!.path).toBe(join(directory, 'models', 'ggml-tiny.bin'))
})

test('모델을 내려받으면 파일을 만들고 진행률을 알린다', async (t) => {
  const progress: number[] = []
  const { ctx, directory } = await setup(t, {
    fetch: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } })
  })
  const status = await ctx.mediaTranscription.installModel(
    { id: 'tiny' },
    { onProgress: (value) => progress.push(value.downloadedBytes) }
  )
  expect(status.installed).toBe(true)
  expect(status.path).toBe(join(directory, 'models', 'ggml-tiny.bin'))
  expect(progress.at(-1)).toBe(3)
  const models = await ctx.mediaTranscription.models()
  expect(models.find((model) => model.id === 'tiny')!.installed).toBe(true)
})

test('전사는 ffmpeg로 오디오를 뽑고 whisper.cpp 결과를 해석한다', async (t) => {
  const { ctx, directory, shell } = await setup(t)
  await writeFile(join(directory, 'video.mp4'), 'video-bytes')
  await placeModel(directory)
  respondWithFixture(shell)
  const transcription = await ctx.mediaTranscription.transcribe({ filePath: join(directory, 'video.mp4') })
  expect(transcription.model).toBe(modelId)
  expect(transcription.language).toBe('ko')
  expect(transcription.words.map((word) => word.text)).toEqual(['안녕', '하세요', '여러분'])
  expect(transcription.segments).toEqual([{ startMs: 0, endMs: 1_500, text: '안녕하세요 여러분' }])
  expect(shell.commands[0]).toContain('-ar 16000')
  expect(shell.commands[1]).toContain('-oj')
  expect(shell.commands[1]).toContain('-ojf')
  expect(shell.commands[1]).toContain('-l auto')
  expect(shell.commands[1]).toContain(join('models', `ggml-${modelId}.bin`))
})

test('언어를 지정하면 whisper 인자에 언어를 넣는다', async (t) => {
  const { ctx, directory, shell } = await setup(t)
  await writeFile(join(directory, 'video.mp4'), 'video-bytes')
  await placeModel(directory)
  respondWithFixture(shell)
  await ctx.mediaTranscription.transcribe({ filePath: join(directory, 'video.mp4'), language: 'ko' })
  expect(shell.commands[1]).toContain('-l ko')
})

test('설치되지 않은 모델로는 전사하지 않는다', async (t) => {
  const { ctx, directory } = await setup(t)
  await writeFile(join(directory, 'video.mp4'), 'video-bytes')
  await expect(ctx.mediaTranscription.transcribe({ filePath: join(directory, 'video.mp4') })).rejects.toThrow(
    'is not installed'
  )
})

test('ffmpeg가 실패하면 마지막 오류 줄을 담아 실패한다', async (t) => {
  const { ctx, directory, shell } = await setup(t)
  await writeFile(join(directory, 'video.mp4'), 'video-bytes')
  await placeModel(directory)
  shell.handler = async () => result({ exitCode: 1, stderr: 'video.mp4: Invalid data found' })
  await expect(ctx.mediaTranscription.transcribe({ filePath: join(directory, 'video.mp4') })).rejects.toThrow(
    'Invalid data found'
  )
})

test('특수 토큰과 빈 구간은 단어 목록에서 제외한다', () => {
  const parsed = parseWhisperJson(fixture)
  expect(parsed.words).toHaveLength(3)
  expect(parsed.words[0]).toEqual({ text: '안녕', startMs: 0, endMs: 600 })
  expect(() => parseWhisperJson('{}')).toThrow('no transcription')
})

test('언어 인자에 셸 명령을 넣거나 모델 경로를 벗어나면 실행하지 않는다', async (t) => {
  const { ctx, directory, shell } = await setup(t)
  await placeModel(directory)
  await expect(
    ctx.mediaTranscription.transcribe({ filePath: '/video.mp4', language: 'ko; touch /tmp/unsafe' })
  ).rejects.toThrow('language')
  await expect(ctx.mediaTranscription.transcribe({ filePath: '/video.mp4', model: '../../secret' })).rejects.toThrow(
    'unknown speech model'
  )
  expect(shell.commands).toEqual([])
})

test('모델 설치를 취소하면 기존 모델을 보존하고 임시 파일을 지운다', async (t) => {
  const controller = new AbortController()
  const { ctx, directory } = await setup(t, {
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array([1, 2, 3]))
          }
        })
      )
  })
  await mkdir(join(directory, 'models'))
  await writeFile(join(directory, 'models', 'ggml-tiny.bin'), 'old-model')
  await expect(
    ctx.mediaTranscription.installModel(
      { id: 'tiny' },
      {
        signal: controller.signal,
        onProgress() {
          controller.abort()
        }
      }
    )
  ).rejects.toThrow()
  expect(await readFile(join(directory, 'models', 'ggml-tiny.bin'), 'utf8')).toBe('old-model')
  expect(await readdir(join(directory, 'models'))).toEqual(['ggml-tiny.bin'])
})

test('플러그인 해제 신호가 오디오 추출 프로세스로 전달된다', async (t) => {
  const { ctx, directory, shell, provider } = await setup(t)
  const service = ctx.mediaTranscription
  await placeModel(directory)
  const started = Promise.withResolvers<void>()
  let aborted = false
  shell.handler = async (_command, options) => {
    started.resolve()
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener(
        'abort',
        () => {
          aborted = true
          resolve()
        },
        { once: true }
      )
    )
    return result({ aborted: true })
  }
  const transcription = service.transcribe({ filePath: '/video.mp4' })
  const rejected = expect(transcription).rejects.toThrow()
  await started.promise
  await provider.dispose()
  await rejected
  expect(aborted).toBe(true)
  expect((await readdir(directory)).filter((name) => name.startsWith('keundal-whisper-'))).toEqual([])
})
