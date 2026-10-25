import { spawnSync } from 'node:child_process'
import { readdir, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import config from './lighthouserc.cjs'

const routes = config.ci.collect.url.map((url) => new URL(url).pathname)
const samples = config.ci.collect.numberOfRuns

// Unlighthouse는 프리뷰가 503을 돌려주면 해당 화면을 건너뛰고도 성공으로 종료한다.
// 보고서 파일 존재 여부로 측정 완료를 판단해야 누락된 표본이 요약 단계에서 드러난다.
export function reportPaths(files) {
  return files.flatMap((file) => {
    const match = /(?:^|\/)reports\/(?:(.+)\/)?lighthouse\.json$/.exec(file.replaceAll('\\', '/'))
    return match ? [match[1] ? `/${match[1]}` : '/'] : []
  })
}

export function missingRoutes(files, expected = routes) {
  const collected = new Set(reportPaths(files))
  return expected.filter((route) => !collected.has(route))
}

export async function readMissing(directory) {
  let files
  try {
    files = await readdir(directory, { recursive: true })
  } catch (error) {
    if (error.code === 'ENOENT') return [...routes]
    throw error
  }
  return missingRoutes(files)
}

export async function collectSample({ sample, run, check, wait, attempts = 3 }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await run(sample)
    const pending = await check()
    if (pending.length === 0) return
    if (attempt === attempts) {
      throw new Error(`${sample}번째 측정에서 ${pending.join(', ')} 화면의 보고서를 만들지 못했습니다.`)
    }
    await wait()
  }
}

function runUnlighthouse(sample, site) {
  const args = [
    'dlx',
    '--allow-build=esbuild',
    '--allow-build=puppeteer',
    '--allow-build=vue-demi',
    '@unlighthouse/cli@0.19.1',
    '--config-file',
    'tools/lighthouse/unlighthouse.config.mjs',
    '--site',
    site
  ]
  const { status, error } = spawnSync('pnpm', args, {
    env: { ...process.env, LIGHTHOUSE_RUN: String(sample) },
    stdio: 'inherit'
  })
  // Unlighthouse의 종료 코드는 측정 누락을 알리지 않으므로 보고서 검사에 맡긴다.
  if (error || status !== 0) console.warn(`${sample}번째 Unlighthouse 실행이 실패했습니다: ${error ?? status}`)
}

async function waitForPreview(site, { attempts = 12, delayMs = 5000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const responses = await Promise.all(
      routes.map(async (route) => {
        try {
          return (await fetch(new URL(route, site))).ok
        } catch {
          return false
        }
      })
    )
    if (responses.every(Boolean)) return
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`프리뷰 ${site}가 모든 화면에서 응답하지 않아 측정을 다시 시도할 수 없습니다.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = process.env.LIGHTHOUSE_BASE_URL
  if (!site) throw new Error('LIGHTHOUSE_BASE_URL 환경 변수가 필요합니다.')
  await waitForPreview(site)
  for (let sample = 1; sample <= samples; sample += 1) {
    const directory = `.unlighthouse/run-${sample}`
    await collectSample({
      sample,
      run: async () => {
        await rm(directory, { recursive: true, force: true })
        runUnlighthouse(sample, site)
      },
      check: () => readMissing(directory),
      wait: () => waitForPreview(site)
    })
  }
}
