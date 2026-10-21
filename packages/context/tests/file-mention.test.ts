import { activeAtToken, formatFileMention } from '@keundal/context'
import { expect, test } from 'vitest'

test('커서의 @ 토큰과 공백 경로 인용을 해석하고 안전한 멘션을 만든다', () => {
  expect(activeAtToken('check @src/fi', 13)).toEqual({ prefix: '@src/fi', query: 'src/fi', quoted: false })
  expect(activeAtToken('mail me@example.com', 19)).toBeUndefined()
  expect(activeAtToken('open @"some dir/fi', 18)).toEqual({
    prefix: '@"some dir/fi',
    query: 'some dir/fi',
    quoted: true
  })
  expect(formatFileMention({ path: 'some dir', kind: 'directory' }, true)).toBe('@"some dir/')
  expect(formatFileMention({ path: 'a"b', kind: 'file' })).toBeUndefined()
})
