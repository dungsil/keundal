import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import fsMediaLibraryPlugin, { FsMediaLibraryService } from '@keundal/plugin-library-fs'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'keundal-library-'))
  const ctx = new Context()
  const provider = await ctx.plugin(fsMediaLibraryPlugin)
  t.onTestFinished(async () => {
    await provider.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { ctx, dir, provider }
}

async function video(t: TestContext, dir: string, name = 'clip.mp4') {
  const path = join(dir, name)
  await writeFile(path, 'video-bytes')
  t.onTestFinished(async () => {
    await rm(path, { force: true })
  })
  return path
}

test('자료库를 만들고 다시 열면 같은 이름과 항목 목록을 돌려준다', async (t) => {
  const { ctx, dir } = await setup(t)
  expect(ctx.media).toBeInstanceOf(FsMediaLibraryService)
  const path = join(dir, 'library.vimpo')
  const created = await ctx.media.create({ path, name: '내 자료库' })
  expect(created.name).toBe('내 자료库')
  const source = await video(t, dir)
  const imported = await ctx.media.import({
    libraryPath: path,
    entries: [{ filePath: source, storage: 'copy', title: '첫 영상' }]
  })
  expect(imported).toHaveLength(1)
  const reopened = await ctx.media.open({ path })
  expect(reopened.name).toBe('내 자료库')
  const items = await ctx.media.list(path)
  expect(items.map((item) => item.title)).toEqual(['첫 영상'])
  expect(items[0]!.video.present).toBe(true)
})

test('복사 항목은 원본을 지워도 남고 연결 항목은 사라진 것을 보고한다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'library.vimpo')
  await ctx.media.create({ path })
  const copiedSource = await video(t, dir, 'copied.mp4')
  const linkedSource = await video(t, dir, 'linked.mp4')
  const [copied, linked] = await ctx.media.import({
    libraryPath: path,
    entries: [
      { filePath: copiedSource, storage: 'copy' },
      { filePath: linkedSource, storage: 'link' }
    ]
  })
  await rm(copiedSource)
  await rm(linkedSource)
  const afterCopy = await ctx.media.read(path, copied!.id)
  const afterLink = await ctx.media.read(path, linked!.id)
  expect(afterCopy.video.present).toBe(true)
  expect(afterLink.video.present).toBe(false)
  expect(afterLink.storage).toBe('link')
})

test('원본 파일을 다시 지정하면 연결 항목이 다시 재생 가능해진다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'library.vimpo')
  await ctx.media.create({ path })
  const source = await video(t, dir, 'moved.mp4')
  const [item] = await ctx.media.import({ libraryPath: path, entries: [{ filePath: source, storage: 'link' }] })
  await rm(source)
  await mkdir(join(dir, 'again'))
  const relocated = join(dir, 'again', 'moved.mp4')
  await writeFile(relocated, 'video-bytes')
  const updated = await ctx.media.relocate({ libraryPath: path, itemId: item!.id, filePath: relocated })
  expect(updated.video.present).toBe(true)
  expect(updated.video.path).toBe(relocated)
})

test('자막 트랙을 저장하면 항목을 다시 읽었을 때 같은 순서로 남는다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'library.vimpo')
  await ctx.media.create({ path })
  const source = await video(t, dir)
  const [item] = await ctx.media.import({ libraryPath: path, entries: [{ filePath: source, storage: 'copy' }] })
  await ctx.media.saveSubtitle({
    libraryPath: path,
    itemId: item!.id,
    track: {
      id: 'original',
      kind: 'original',
      language: 'ko',
      segments: [{ startMs: 0, endMs: 1200, text: '안녕하세요', speaker: null }]
    }
  })
  const tracks = (await ctx.media.read(path, item!.id)).subtitleTracks
  expect(tracks).toHaveLength(1)
  expect(tracks[0]!.segments[0]!.text).toBe('안녕하세요')
})

test('새로운 버전이 만든 자료库는 열기를 거부한다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'newer.vimpo')
  await ctx.media.create({ path })
  const manifest = JSON.parse(await readFile(join(path, 'library.json'), 'utf8')) as Record<string, unknown>
  await writeFile(join(path, 'library.json'), JSON.stringify({ ...manifest, version: 99 }))
  await expect(ctx.media.open({ path })).rejects.toThrow('newer version')
})

test('삭제는 휴지통 폴더로 옮기고, 영구 삭제는 항목 폴더를 지운다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'library.vimpo')
  await ctx.media.create({ path })
  const source = await video(t, dir)
  const [kept, removed] = await ctx.media.import({
    libraryPath: path,
    entries: [
      { filePath: source, storage: 'copy', title: '남길 영상' },
      { filePath: source, storage: 'copy', title: '지울 영상' }
    ]
  })
  await ctx.media.remove({ libraryPath: path, itemId: removed!.id })
  const remaining = await ctx.media.list(path)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]!.title).toBe('남길 영상')
  await ctx.media.remove({ libraryPath: path, itemId: kept!.id, permanent: true })
  await expect(ctx.media.read(path, kept!.id)).rejects.toThrow()
})

test('항목 ID의 경로 이동과 숨김 디렉터리는 거부한다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'library')
  await ctx.media.create({ path })
  for (const itemId of ['..', '.', '../outside', 'nested/item', 'nested\\item', '.trash']) {
    await expect(ctx.media.read(path, itemId)).rejects.toThrow('itemId')
    await expect(ctx.media.remove({ libraryPath: path, itemId, permanent: true })).rejects.toThrow('itemId')
  }
  expect((await ctx.media.open({ path })).path).toBe(path)
})

test('복사한 파일 이름이 item.json이어도 영상과 항목 정보를 따로 보존한다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'library')
  await ctx.media.create({ path })
  const source = await video(t, dir, 'item.json')
  const [item] = await ctx.media.import({ libraryPath: path, entries: [{ filePath: source, storage: 'copy' }] })
  expect(await readFile(item!.video.path, 'utf8')).toBe('video-bytes')
  expect((await ctx.media.list(path))[0]!.id).toBe(item!.id)
})

test('심볼릭 링크로 지정한 root 밖의 자료库를 열지 않는다', async (t) => {
  const { ctx, dir } = await setup(t)
  const root = join(dir, 'root')
  const outside = join(dir, 'outside')
  await mkdir(root)
  await ctx.media.create({ path: outside })
  await symlink(outside, join(root, 'escaped'), 'dir')
  const restricted = new Context()
  const provider = await restricted.plugin(fsMediaLibraryPlugin, { root })
  t.onTestFinished(() => provider.dispose())
  await expect(restricted.media.open({ path: join(root, 'escaped') })).rejects.toThrow('outside')
})

test('복사 항목의 manifest가 자료库 밖을 가리키면 읽지 않는다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'library')
  await ctx.media.create({ path })
  const source = await video(t, dir)
  const [item] = await ctx.media.import({ libraryPath: path, entries: [{ filePath: source, storage: 'copy' }] })
  const manifestPath = join(path, item!.id, 'item.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, videoPath: '../../clip.mp4' }))
  await expect(ctx.media.read(path, item!.id)).rejects.toThrow('outside')
})

test('같은 항목에 자막을 동시에 저장해도 모든 트랙을 보존한다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'library')
  await ctx.media.create({ path })
  const source = await video(t, dir)
  const [item] = await ctx.media.import({ libraryPath: path, entries: [{ filePath: source, storage: 'copy' }] })
  await Promise.all(
    ['ko', 'en', 'ja'].map((language) =>
      ctx.media.saveSubtitle({
        libraryPath: path,
        itemId: item!.id,
        track: { id: `translation:${language}`, language, kind: 'translation', segments: [] }
      })
    )
  )
  expect((await ctx.media.read(path, item!.id)).subtitleTracks.map((track) => track.language).sort()).toEqual([
    'en',
    'ja',
    'ko'
  ])
})

test('가져오기가 실패하면 불완전한 항목 폴더를 남기지 않는다', async (t) => {
  const { ctx, dir } = await setup(t)
  const path = join(dir, 'library')
  await ctx.media.create({ path })
  const source = await video(t, dir)
  await expect(
    ctx.media.import({ libraryPath: path, entries: [{ filePath: source, storage: 'copy', title: ' ' }] })
  ).rejects.toThrow('title')
  expect(await ctx.media.list(path)).toEqual([])
})
