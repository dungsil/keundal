import assert from 'node:assert/strict'
import test from 'node:test'

import { summarize } from './summary.mjs'

const url = 'https://preview.example/settings'
const collect = { url: [url], numberOfRuns: 3 }
function report(score, overrides = {}) {
  return {
    audits: { 'cumulative-layout-shift': { numericValue: 0.05 } },
    requestedUrl: url,
    finalDisplayedUrl: url,
    categories: Object.fromEntries(
      ['performance', 'accessibility', 'best-practices', 'seo'].map((id) => [id, { score }])
    ),
    ...overrides
  }
}

test('세 측정값의 중앙값을 표시하고 70점 이하인 항목을 병합 차단 사유로 반환한다', () => {
  const { markdown, failures } = summarize([report(0.9), report(0.1), report(0.2)], collect)
  assert.match(markdown, /\| \/settings \| 20 \| 20 \| 20 \| 20 \|/)
  assert.match(markdown, /병합을 차단합니다/)
  assert.deepEqual(failures, [
    '/settings의 성능 20점',
    '/settings의 접근성 20점',
    '/settings의 권장사항 20점',
    '/settings의 SEO 20점'
  ])
})

test('중앙값이 70점이면 차단하고 71점이면 통과한다', () => {
  const scores = (performance) => ({
    performance: { score: performance },
    accessibility: { score: 1 },
    'best-practices': { score: 1 },
    seo: { score: 1 }
  })
  const atLimit = [0.7, 0.7, 0.7].map((score) => report(1, { categories: scores(score) }))
  assert.deepEqual(summarize(atLimit, collect).failures, ['/settings의 성능 70점'])
  const aboveLimit = [0.71, 0.71, 0.71].map((score) => report(1, { categories: scores(score) }))
  assert.deepEqual(summarize(aboveLimit, collect).failures, [])
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

test('접근성 및 CLS 예산 경계와 중앙값을 검사한다', () => {
  const sample = (cls, accessibility = 0.9) =>
    report(1, {
      categories: { ...report(1).categories, accessibility: { score: accessibility } },
      audits: { 'cumulative-layout-shift': { numericValue: cls } }
    })
  assert.deepEqual(summarize([sample(0), sample(0.1), sample(1)], collect).failures, [])
  assert.deepEqual(summarize([sample(0.11, 0.89), sample(0.11, 0.89), sample(0)], collect).failures, [
    '/settings의 접근성 89점',
    '/settings의 CLS 0.11 (최대 0.1)'
  ])
  assert.throws(
    () => summarize([report(1), report(1), report(1, { audits: {} })], collect),
    /missing cumulative-layout-shift/
  )
  assert.throws(
    () => summarize([report(1), report(1), report(1)], collect, { performance: NaN }),
    /Invalid Lighthouse budget/
  )
})
