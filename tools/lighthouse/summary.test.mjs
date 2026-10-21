import assert from 'node:assert/strict'
import test from 'node:test'

import { summarize } from './summary.mjs'

const url = 'https://preview.example/settings'
const collect = { url: [url], numberOfRuns: 3 }
function report(score, overrides = {}) {
  return {
    requestedUrl: url,
    finalDisplayedUrl: url,
    categories: Object.fromEntries(
      ['performance', 'accessibility', 'best-practices', 'seo'].map((id) => [id, { score }])
    ),
    ...overrides
  }
}

test('낮은 점수도 실패하지 않고 세 측정값의 중앙값을 표시한다', () => {
  assert.match(summarize([report(0.9), report(0.1), report(0.2)], collect), /\| \/settings \| 20 \| 20 \| 20 \| 20 \|/)
})

test('측정 누락과 점수 누락을 성공한 결과로 표시하지 않는다', () => {
  assert.throws(() => summarize([report(1)], collect), /expected 3 reports/)
  assert.throws(() => summarize([report(1), report(1), report(null)], collect), /missing performance score/)
})

test('브라우저 오류와 로그인 화면으로의 이동을 감지한다', () => {
  assert.throws(
    () => summarize([report(1), report(1), report(1, { runtimeError: { code: 'NO_FCP' } })], collect),
    /audit failed/
  )
  assert.throws(
    () => summarize([report(1), report(1), report(1, { finalDisplayedUrl: 'https://preview.example/login' })], collect),
    /redirected/
  )
})
