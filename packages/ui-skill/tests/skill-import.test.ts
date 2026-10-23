import { File } from 'node:buffer'
import { strToU8, zipSync } from 'fflate'
import { expect, test } from 'vitest'
import { importSkillFile } from '../app/lib/skill-import'

const markdown = '---\nname: review\ndescription: 코드 검토\n---\n변경 사항을 검토합니다.'
const definition = { name: 'review', description: '코드 검토', content: '변경 사항을 검토합니다.' }
function archive(entries: Record<string, string>, name = 'skill.zip') {
  return new File([zipSync(Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)])))], name)
}

test('SKILL.md 파일을 기존과 같이 가져온다', async () => {
  await expect(importSkillFile(new File([markdown], 'SKILL.md'))).resolves.toEqual(definition)
})

test.each(['SKILL.md', 'review/SKILL.md', 'export/skills/review/SKILL.md'])('ZIP의 %s를 가져오고 부속 파일은 제외한다', async (path) => {
  await expect(importSkillFile(archive({ [path]: markdown, 'scripts/check.py': 'print(1)' }, 'skill.ZIP'))).resolves.toEqual(definition)
})

test('macOS 메타데이터 안의 SKILL.md는 무시한다', async () => {
  await expect(importSkillFile(archive({ 'review/SKILL.md': markdown, '__MACOSX/review/SKILL.md': 'metadata' }))).resolves.toEqual(definition)
})

test('SKILL.md가 없는 ZIP은 거부한다', async () => {
  await expect(importSkillFile(archive({ 'README.md': markdown }))).rejects.toThrow('must contain a SKILL.md')
})

test('SKILL.md가 여러 개면 임의로 선택하지 않고 거부한다', async () => {
  await expect(importSkillFile(archive({ 'one/SKILL.md': markdown, 'two/SKILL.md': markdown }))).rejects.toThrow('exactly one')
})

test('손상된 ZIP은 거부한다', async () => {
  await expect(importSkillFile(new File(['not a zip'], 'skill.zip'))).rejects.toThrow()
})

test('ZIP 안의 잘못된 스킬 메타데이터는 거부한다', async () => {
  await expect(importSkillFile(archive({ 'SKILL.md': 'no frontmatter' }))).rejects.toThrow('frontmatter')
})

test('압축을 푼 SKILL.md가 1 MiB를 넘으면 거부한다', async () => {
  await expect(importSkillFile(archive({ 'SKILL.md': markdown + 'a'.repeat(1024 * 1024) }))).rejects.toThrow('1 MiB')
})

test('ZIP이 10 MiB를 넘으면 읽기 전에 거부한다', async () => {
  await expect(importSkillFile(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'skill.zip'))).rejects.toThrow('10 MiB')
})
