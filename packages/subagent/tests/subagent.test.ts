import { parseSubagentRoles } from '@keundal/subagent'
import { expect, test } from 'vitest'

const role = { name: 'reviewer', description: 'Review changes', instructions: 'Check correctness.' }

test('역할 정의의 앞뒤 공백을 제거하고 빈 목록으로 역할을 지울 수 있다', () => {
  expect(
    parseSubagentRoles([{ name: ' reviewer ', description: ' Review changes ', instructions: ' Check correctness. ' }])
  ).toEqual([role])
  expect(parseSubagentRoles([])).toEqual([])
})

test.for([
  null,
  {},
  [{ ...role, name: '' }],
  [{ ...role, name: 'invalid name' }],
  [{ ...role, name: 'a'.repeat(65) }],
  [{ ...role, description: ' ' }],
  [{ ...role, description: 'a'.repeat(501) }],
  [{ ...role, instructions: ' ' }],
  [{ ...role, instructions: 'a'.repeat(20_001) }],
  [role, { ...role, name: ' reviewer ' }],
  [{ ...role, model: 'other' }],
  Array.from({ length: 33 }, (_, i) => ({ ...role, name: `role-${i}` }))
])('잘못된 역할 목록 %#을 거부한다', (value) => {
  expect(() => parseSubagentRoles(value)).toThrow()
})

test('역할 수와 필드 길이의 상한을 허용한다', () => {
  const roles = Array.from({ length: 32 }, (_, i) => ({
    name: `${i}`.padEnd(64, '_'),
    description: 'd'.repeat(500),
    instructions: 'i'.repeat(20_000)
  }))
  expect(parseSubagentRoles(roles)).toEqual(roles)
})
