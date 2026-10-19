import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import localFileSystemPlugin from '@keundal/plugin-fs-local'
import fileSystemPolicyPlugin, { PolicyFileSystemService } from '@keundal/plugin-fs-policy'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

async function setup(t: TestContext, writable = true, limits = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'keundal-policy-'))
  const root = join(dir, 'root')
  await mkdir(root)
  const ctx = new Context()
  const raw = ctx.isolate('fs')
  const provider = await raw.plugin(localFileSystemPlugin, { cwd: root })
  const policy = await ctx.plugin(fileSystemPolicyPlugin, {
    backend: raw.fs,
    roots: [root],
    writableRoots: writable ? [root] : [],
    ...limits
  })
  t.onTestFinished(async () => {
    await policy.dispose()
    await provider.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { ctx, raw, dir, root, policy, fs: ctx.fs as PolicyFileSystemService }
}

test('읽기와 수정에 경로 경계를 적용하고 외부 심볼릭 링크도 거부한다', async (t) => {
  const { fs, dir, root } = await setup(t)
  await writeFile(join(dir, 'secret'), 'private')
  await mkdir(`${root}-sibling`)
  await writeFile(`${root}-sibling/file`, 'sibling')
  await symlink(dir, join(root, 'escape'))
  const options = { scope: 'thread' }
  for (const path of ['../secret', `${root}-sibling/file`, 'escape/secret', 'escape/new']) {
    await expect(fs.read(path, options)).rejects.toThrow('outside')
    await expect(fs.write(path, 'bad', options)).rejects.toThrow('outside')
    await expect(fs.edit(path, { oldText: 'private', newText: 'bad' }, options)).rejects.toThrow('outside')
  }
  await expect(fs.list('escape')).rejects.toThrow('outside')
  expect(await readFile(join(dir, 'secret'), 'utf8')).toBe('private')
})

test('기존 파일은 같은 scope에서 읽어야 수정하고 별칭은 같은 파일로 취급한다', async (t) => {
  const { fs, root } = await setup(t)
  await writeFile(join(root, 'file'), 'first')
  await symlink('file', join(root, 'alias'))
  const one = { scope: 'one' }
  const two = { scope: 'two' }
  await expect(fs.write('file', 'blind', one)).rejects.toThrow('version conflict')
  await expect(fs.edit('file', { oldText: 'first', newText: 'blind' }, one)).rejects.toThrow('before editing')
  const read = await fs.read('alias', one)
  await expect(fs.write('file', 'other', two)).rejects.toThrow('version conflict')
  await expect(fs.write('file', 'bypass', { ...two, expectedVersion: read.version })).rejects.toThrow('observed')
  await fs.edit('file', { oldText: 'first', newText: 'second' }, one)
  await fs.write('alias', 'third', one)
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('third')
  await fs.write('new', 'created', two)
  expect((await fs.read('new')).content).toBe('created')
  await expect(fs.write('no-scope', 'x')).rejects.toThrow('scope')
})

test('외부 변경과 같은 버전의 동시 수정을 충돌로 처리한다', async (t) => {
  const { fs, root } = await setup(t)
  await writeFile(join(root, 'file'), 'aaaa')
  await fs.read('file', { scope: 'thread' })
  await writeFile(join(root, 'file'), 'bbbb')
  await expect(fs.write('file', 'cccc', { scope: 'thread' })).rejects.toThrow('version conflict')
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('bbbb')
  await fs.read('file', { scope: 'thread' })
  const results = await Promise.allSettled([
    fs.write('file', 'left', { scope: 'thread' }),
    fs.write('file', 'right', { scope: 'thread' })
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(['left', 'right']).toContain(await readFile(join(root, 'file'), 'utf8'))
})

test('쓰기 허용 경로를 생략하면 읽기만 허용하고 취소와 해제를 반영한다', async (t) => {
  const { fs, raw, policy } = await setup(t, false)
  await raw.fs.write('file', 'original')
  await fs.read('file', { scope: 'thread' })
  await expect(fs.write('file', 'new', { scope: 'thread' })).rejects.toThrow('read-only')
  await expect(fs.write('new', 'new', { scope: 'thread' })).rejects.toThrow('read-only')
  await expect(fs.read('file', { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled')
  await policy.dispose()
  await expect(fs.read('file')).rejects.toThrow('disposed')
  expect((await raw.fs.read('file')).content).toBe('original')
})

test('읽기 기록을 지우거나 한도로 축출하면 다시 읽기 전 수정을 거부한다', async (t) => {
  const { fs, raw } = await setup(t, true, { maxScopes: 1, maxFilesPerScope: 1 })
  await raw.fs.write('a', 'a')
  await raw.fs.write('b', 'b')
  await fs.read('a', { scope: 'one' })
  await fs.read('b', { scope: 'one' })
  await expect(fs.write('a', 'x', { scope: 'one' })).rejects.toThrow('version conflict')
  await fs.read('a', { scope: 'two' })
  await expect(fs.write('b', 'x', { scope: 'one' })).rejects.toThrow('version conflict')
  fs.forget('two')
  await expect(fs.write('a', 'x', { scope: 'two' })).rejects.toThrow('version conflict')
  await fs.read('a', { scope: 'two' })
  await fs.write('a', 'ok', { scope: 'two' })
  expect((await raw.fs.read('a')).content).toBe('ok')
})
