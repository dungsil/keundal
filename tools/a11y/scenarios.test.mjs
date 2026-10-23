import assert from 'node:assert/strict'
import { test } from 'node:test'

import { scenarioTitles } from './scenarios.mjs'

test('실행되는 테스트 제목만 수집하고 주석과 문자열은 제외한다', () => {
  assert.deepEqual(
    scenarioTitles(`
    // test('주석 @a11y:comment', () => {})
    const example = "test('문자열 @a11y:string', () => {})"
    test('실행 @a11y:real', async () => {})
  `),
    ['실행 @a11y:real']
  )
})

test('건너뛴 테스트와 건너뛴 그룹의 테스트는 제외한다', () => {
  assert.deepEqual(
    scenarioTitles(`
    test.skip('제외 @a11y:skip', () => {})
    test.fixme('제외 @a11y:fixme', () => {})
    test.describe.skip('그룹', () => { test('제외 @a11y:nested', () => {}) })
    test.describe.fixme('그룹', () => { test('제외 @a11y:nested', () => {}) })
    test.describe('그룹', () => { test('실행 @a11y:real', () => {}) })
  `),
    ['실행 @a11y:real']
  )
})
