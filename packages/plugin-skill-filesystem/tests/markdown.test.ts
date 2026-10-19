import { parseSkillMarkdown } from '@keundal/plugin-skill-filesystem/markdown'
import { expect, test, vi } from 'vitest'

vi.mock('node:fs/promises', () => {
  throw new Error('portable entry must not import node:fs/promises')
})
vi.mock('node:path', () => {
  throw new Error('portable entry must not import node:path')
})

test('Node 파일 시스템 없이 BOM과 CRLF가 있는 Markdown을 파싱한다', () => {
  expect(
    parseSkillMarkdown('\uFEFF---\r\nname: review-changes\r\ndescription: Review changes\r\n---\r\n  # Review\r\n')
  ).toEqual({ name: 'review-changes', description: 'Review changes', content: '# Review' })
})

test.for([
  ['frontmatter가 없다', 'body only', 'YAML frontmatter is required'],
  ['이름이 없다', '---\ndescription: test\n---\nbody', 'name and description are required'],
  ['설명이 없다', '---\nname: review\n---\nbody', 'name and description are required'],
  ['이름이 유효하지 않다', '---\nname: ../review\ndescription: test\n---\nbody', 'invalid skill name'],
  ['설명이 비었다', '---\nname: review\ndescription: " "\n---\nbody', 'description must be a non-empty string'],
  ['본문이 비었다', '---\nname: review\ndescription: test\n---\n  \n', 'skill content must not be empty'],
  ['YAML 키가 중복이다', '---\nname: one\nname: two\ndescription: test\n---\nbody', 'Map keys must be unique']
])('%s이면 파싱 오류를 전달한다', ([, markdown, error]) => {
  expect(() => parseSkillMarkdown(markdown)).toThrow(error)
})
