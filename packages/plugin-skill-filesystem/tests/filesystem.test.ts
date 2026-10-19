import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import skillPlugin from '@keundal/plugin-skill'
import filesystemSkillPlugin, { createFilesystemSkillProvider } from '@keundal/plugin-skill-filesystem'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

async function root(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'keundal-skills-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}
async function writeSkill(root: string, directory: string, text: string) {
  const path = join(root, directory, 'SKILL.md')
  await mkdir(join(root, directory), { recursive: true })
  await writeFile(path, text)
  return path
}
const markdown = (name: string, body = '# Instructions', description = 'Review changes') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

test('바로 아래 SKILL.md의 frontmatter 이름만 목록에 넣고 본문은 로딩 시 다시 읽는다', async (t) => {
  const directory = await root(t)
  const path = await writeSkill(directory, 'different-directory', markdown('review', 'Original body'))
  await writeSkill(directory, 'nested/hidden', markdown('hidden'))
  await writeFile(join(directory, 'ignored.md'), markdown('ignored'))
  const provider = createFilesystemSkillProvider({ roots: [directory] })
  const catalog = await provider.prepare()
  expect(catalog.skills).toEqual([{ name: 'review', description: 'Review changes' }])
  await writeFile(path, markdown('review', 'Changed body'))
  expect(await catalog.load('review')).toEqual({
    name: 'review',
    description: 'Review changes',
    content: 'Changed body'
  })
  expect(await catalog.load('../different-directory')).toBeUndefined()
  await writeFile(path, markdown('renamed'))
  await expect(catalog.load('review')).rejects.toThrow('skill name changed')
  await rm(path)
  await expect(catalog.load('review')).rejects.toThrow(path)
})

test('여러 루트의 중복 이름을 오류로 보고한다', async (t) => {
  const first = await root(t)
  const second = await root(t)
  await writeSkill(first, 'one', markdown('same'))
  await writeSkill(second, 'two', markdown('same'))
  await expect(createFilesystemSkillProvider({ roots: [first, second] }).prepare()).rejects.toThrow(
    'duplicate skill name same'
  )
})

test.for([
  ['본문만 있다', 'body only', 'frontmatter'],
  ['이름이 경로이다', markdown('../escape'), 'invalid skill name'],
  ['설명이 비었다', markdown('review', 'body', '""'), 'description'],
  ['본문이 비었다', markdown('review', ''), 'content'],
  ['YAML 키가 중복이다', '---\nname: one\nname: two\ndescription: test\n---\nbody', 'Map keys must be unique']
])('%s이면 파일 경로와 오류를 전달한다', async ([, text, error], t) => {
  const directory = await root(t)
  const path = await writeSkill(directory, 'invalid', text)
  const task = createFilesystemSkillProvider({ roots: [directory] }).prepare()
  await expect(task).rejects.toThrow(path)
  await expect(task).rejects.toThrow(error)
})

test('플러그인 해제가 등록된 공급자를 제거하고 진행 중 로딩을 취소한다', async (t) => {
  const directory = await root(t)
  await writeSkill(directory, 'review', markdown('review'))
  const ctx = new Context()
  const registry = await ctx.plugin(skillPlugin)
  const filesystem = await ctx.plugin(filesystemSkillPlugin, { roots: [directory] })
  t.onTestFinished(async () => {
    await filesystem.dispose()
    await registry.dispose()
  })
  const catalog = await ctx.skills.prepare()
  const controller = new AbortController()
  controller.abort(new Error('cancel read'))
  await expect(catalog.load('review', { signal: controller.signal })).rejects.toThrow('cancel read')
  const task = catalog.load('review')
  const rejection = expect(task).rejects.toThrow('skill provider disposed')
  await filesystem.dispose()
  await rejection
  expect((await ctx.skills.prepare()).skills).toEqual([])
})
