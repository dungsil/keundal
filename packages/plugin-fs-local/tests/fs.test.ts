import { execFileSync } from 'node:child_process'
import { watch } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import localFileSystemPlugin, { LocalFileSystemService } from '@keundal/plugin-fs-local'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

async function setup(t: TestContext, maxFileBytes?: number) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'keundal-fs-'))
  const ctx = new Context()
  const fiber = await ctx.plugin(localFileSystemPlugin, { cwd, maxFileBytes })
  t.onTestFinished(async () => {
    await fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  })
  return { fs: ctx.fs, cwd, fiber }
}

async function createSymlink(t: TestContext, target: string, link: string) {
  try {
    await symlink(target, link)
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('심볼릭 링크를 만들 권한이 없습니다.')
    }
    throw error
  }
}

test('플러그인이 공개 서비스를 등록하고 파일과 디렉터리를 읽는다', async (t) => {
  const { fs, cwd } = await setup(t)
  expect(fs).toBeInstanceOf(LocalFileSystemService)
  const created = await fs.write('hello.txt', '안녕하세요')
  await mkdir(path.join(cwd, 'folder'))
  expect(await fs.read('hello.txt')).toEqual({ ...created, content: '안녕하세요' })
  expect(created.path).toBe(path.join(await realpath(cwd), 'hello.txt'))
  expect(await fs.list('.')).toEqual(
    expect.arrayContaining([
      { name: 'hello.txt', kind: 'file' },
      { name: 'folder', kind: 'directory' }
    ])
  )
})

test('디렉터리 목록에서 심볼릭 링크를 구분한다', async (t) => {
  const { fs, cwd } = await setup(t)
  await fs.write('hello.txt', '안녕하세요')
  await createSymlink(t, 'hello.txt', path.join(cwd, 'alias'))
  expect(await fs.list('.')).toEqual(expect.arrayContaining([{ name: 'alias', kind: 'symlink' }]))
})

test('관찰한 버전으로 정확히 한 번 나타나는 문자열만 바꾼다', async (t) => {
  const { fs } = await setup(t)
  const original = await fs.write('edit', 'one two two aaa')
  for (const oldText of ['', 'absent', 'two', 'aa']) {
    await expect(fs.edit('edit', { oldText, newText: 'x' }, { expectedVersion: original.version })).rejects.toThrow(
      'exactly once'
    )
  }
  await expect(fs.edit('edit', { oldText: 'one', newText: 'ONE' })).rejects.toThrow()
  const edited = await fs.edit('edit', { oldText: 'one', newText: '$&' }, { expectedVersion: original.version })
  expect(edited.version).not.toBe(original.version)
  expect((await fs.read('edit')).content).toBe('$& two two aaa')
  await expect(fs.edit('missing', { oldText: 'one', newText: 'x' })).rejects.toThrow('observed version')
})

test('버전을 생략하거나 null로 지정하면 기존 파일을 덮어쓰지 않는다', async (t) => {
  const { fs } = await setup(t)
  await fs.write('file', 'old', { expectedVersion: null })
  for (const options of [{}, { expectedVersion: null }, { expectedVersion: 'unknown' }]) {
    await expect(fs.write('file', 'new', options)).rejects.toThrow('version conflict')
  }
  await expect(fs.write('absent', 'new', { expectedVersion: 'unknown' })).rejects.toThrow('version conflict')
  expect((await fs.read('file')).content).toBe('old')
})

test('같은 크기의 외부 변경도 이전 버전을 무효화한다', async (t) => {
  const { fs, cwd } = await setup(t)
  const first = await fs.write('file', 'aaaa')
  const before = await stat(first.path)
  await writeFile(path.join(cwd, 'file'), 'bbbb')
  await utimes(first.path, before.atime, before.mtime)
  expect((await fs.read('file')).version).not.toBe(first.version)
  await expect(fs.write('file', 'cccc', { expectedVersion: first.version })).rejects.toThrow('version conflict')
  await expect(
    fs.edit('file', { oldText: 'bbbb', newText: 'cccc' }, { expectedVersion: first.version })
  ).rejects.toThrow('version conflict')
  expect((await fs.read('file')).content).toBe('bbbb')
})

test('동시에 생성하는 두 서비스 중 하나만 파일을 만든다', async (t) => {
  const { fs, cwd } = await setup(t)
  const ctx = new Context()
  const fiber = await ctx.plugin(localFileSystemPlugin, { cwd })
  t.onTestFinished(() => fiber.dispose())
  const results = await Promise.allSettled([fs.write('race', 'left'), ctx.fs.write('race', 'right')])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(['left', 'right']).toContain((await fs.read('race')).content)
  expect(await readdir(cwd)).toEqual(['race'])
})

test('같은 버전의 동시 쓰기를 직렬화하고 심볼릭 링크 별칭에도 적용한다', async (t) => {
  const { fs, cwd } = await setup(t)
  const first = await fs.write('file', 'old')
  await createSymlink(t, 'file', path.join(cwd, 'alias'))
  const results = await Promise.allSettled([
    fs.write('file', 'left', { expectedVersion: first.version }),
    fs.write('alias', 'right', { expectedVersion: first.version })
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect((await fs.read('alias')).path).toBe(first.path)
  expect((await stat(path.join(cwd, 'alias'))).isFile()).toBe(true)
  expect(await readdir(cwd)).toEqual(['alias', 'file'])
})

test('취소된 쓰기는 파일을 만들거나 기존 내용을 바꾸지 않는다', async (t) => {
  const { fs, cwd } = await setup(t)
  const first = await fs.write('file', 'old')
  const signal = AbortSignal.abort(new Error('cancelled'))
  await expect(fs.write('new', 'new', { signal })).rejects.toThrow('cancelled')
  await expect(fs.write('file', 'new', { signal, expectedVersion: first.version })).rejects.toThrow('cancelled')
  const controller = new AbortController()
  const watcher = watch(cwd, (_event, name) => {
    if (name?.startsWith('.keundal-')) controller.abort(new Error('staging cancelled'))
  })
  try {
    await expect(
      fs.write('file', 'new', { signal: controller.signal, expectedVersion: first.version })
    ).rejects.toThrow()
  } finally {
    watcher.close()
  }
  expect(await readFile(first.path, 'utf8')).toBe('old')
  expect(await readdir(cwd)).toEqual(['file'])
})

test('심볼릭 링크 다음의 ..과 없는 경로를 기존 조상에서 해석한다', async (t) => {
  const { fs, cwd } = await setup(t)
  await mkdir(path.join(cwd, 'real', 'nested'), { recursive: true })
  await createSymlink(t, 'real/nested', path.join(cwd, 'alias'))
  const root = await realpath(cwd)
  expect(await fs.resolve('alias/../missing/child')).toBe(path.join(root, 'real/missing/child'))
  await createSymlink(t, 'real/not-created', path.join(cwd, 'dangling'))
  expect(await fs.resolve('dangling/child')).toBe(path.join(root, 'real/not-created/child'))
  await expect(fs.write('alias/missing/child', 'x')).rejects.toThrow()
  expect(await readdir(path.join(cwd, 'real/nested'))).toEqual([])
  await expect(fs.resolve('bad\0path')).rejects.toThrow('NUL')
  expect(fs.contains(root, root)).toBe(true)
  expect(fs.contains(root, path.join(root, 'child'))).toBe(true)
  expect(fs.contains(root, `${root}-sibling`)).toBe(false)
  expect(fs.contains(root, path.dirname(root))).toBe(false)
})

test('바이트 한도를 검사하고 교체할 파일의 권한을 보존한다', async (t) => {
  const { fs, cwd } = await setup(t, 4)
  await expect(fs.write('too-big', '가나')).rejects.toThrow('maxFileBytes')
  await writeFile(path.join(cwd, 'external'), '12345')
  await expect(fs.read('external')).rejects.toThrow('maxFileBytes')
  await fs.write('file', '1234')
  await chmod(path.join(cwd, 'file'), 0o640)
  const first = await fs.read('file')
  await fs.write('file', 'next', { expectedVersion: first.version })
  if (process.platform !== 'win32') expect((await stat(first.path)).mode & 0o777).toBe(0o640)
  await expect(fs.read('.')).rejects.toThrow('regular file')
})

test('기본 한도는 1MiB이며 초과한 파일을 거부한다', async (t) => {
  const { fs } = await setup(t)
  await fs.write('limit', 'x'.repeat(1024 * 1024))
  expect((await fs.read('limit')).content.length).toBe(1024 * 1024)
  await expect(fs.write('over', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow('maxFileBytes')
})

test.skipIf(process.platform !== 'linux')('named pipe를 읽으려 하면 대기하지 않고 거부한다', async (t) => {
  const { fs, cwd } = await setup(t)
  execFileSync('mkfifo', [path.join(cwd, 'pipe')])
  await expect(fs.read('pipe')).rejects.toThrow('regular file')
})

test('플러그인을 해제하면 보관한 참조로 파일을 읽거나 수정할 수 없다', async (t) => {
  const { fs, cwd, fiber } = await setup(t)
  const file = await fs.write('file', 'original')
  await fiber.dispose()
  await expect(fs.read('file')).rejects.toThrow('disposed')
  await expect(fs.write('file', 'changed', { expectedVersion: file.version })).rejects.toThrow('disposed')
  expect(await readFile(path.join(cwd, 'file'), 'utf8')).toBe('original')
})
