import assert from 'node:assert/strict'
import test from 'node:test'

import { collectSample, missingRoutes, reportPaths } from './collect.mjs'

const routes = ['/', '/settings/appearance', '/settings/llm']

test('보고서 파일 경로에서 측정한 화면 경로를 만든다', () => {
  assert.deepEqual(
    reportPaths([
      'reports/lighthouse.json',
      'reports/settings/appearance/lighthouse.json',
      'run-1/reports/settings/llm/lighthouse.json'
    ]),
    ['/', '/settings/appearance', '/settings/llm']
  )
})

test('보고서가 아닌 파일은 화면 경로로 만들지 않는다', () => {
  assert.deepEqual(
    reportPaths(['ci-result.json', 'reports/settings/llm/lighthouse.html', 'reports/__screenshot-thumbnails__/a.png']),
    []
  )
})

test('보고서가 없는 화면을 누락으로 반환한다', () => {
  assert.deepEqual(missingRoutes(['reports/lighthouse.json'], routes), ['/settings/appearance', '/settings/llm'])
})

test('모든 화면을 측정하면 재시도 없이 끝난다', async () => {
  const calls = []
  await collectSample({
    sample: 1,
    run: async () => calls.push('run'),
    check: async () => [],
    wait: async () => calls.push('wait')
  })
  assert.deepEqual(calls, ['run'])
})

test('누락된 화면이 있으면 서버를 기다린 뒤 다시 측정한다', async () => {
  const calls = []
  let remaining = ['/settings/llm']
  await collectSample({
    sample: 2,
    run: async (sample) => calls.push(`run-${sample}`),
    check: async () => {
      calls.push('check')
      return remaining
    },
    wait: async () => {
      calls.push('wait')
      remaining = []
    }
  })
  assert.deepEqual(calls, ['run-2', 'check', 'wait', 'run-2', 'check'])
})

test('재시도에도 누락된 화면이 남으면 누락 경로를 알리며 실패한다', async () => {
  await assert.rejects(
    collectSample({
      sample: 3,
      attempts: 2,
      run: async () => {},
      check: async () => ['/settings/llm'],
      wait: async () => {}
    }),
    /3번째 측정에서 \/settings\/llm 화면의 보고서를 만들지 못했습니다/
  )
})
