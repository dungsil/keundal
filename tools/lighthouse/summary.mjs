import { readFile, readdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import config from './lighthouserc.cjs'

const categories = ['performance', 'accessibility', 'best-practices', 'seo']
const categoryLabels = {
  performance: '성능',
  accessibility: '접근성',
  'best-practices': '권장사항',
  seo: 'SEO'
}

// A median score at or below this value blocks the merge.
export const blockingScore = 70

export function summarize(reports, collect = config.ci.collect) {
  const failures = []
  const rows = collect.url.map((url) => {
    const path = new URL(url).pathname
    const runs = reports.filter((report) => report.requestedUrl === url)
    if (runs.length !== collect.numberOfRuns) {
      throw new Error(`${url}: expected ${collect.numberOfRuns} reports, got ${runs.length}`)
    }
    if (
      runs.some(
        (report) =>
          report.runtimeError ||
          (report.finalDisplayedUrl && new URL(report.finalDisplayedUrl).pathname !== new URL(url).pathname)
      )
    ) {
      throw new Error(`${url}: audit failed or redirected to another page`)
    }
    const scores = categories.map((category) => {
      const values = runs.map((report) => report.categories?.[category]?.score)
      if (values.some((score) => typeof score !== 'number' || !Number.isFinite(score))) {
        throw new Error(`${url}: missing ${category} score`)
      }
      values.sort((a, b) => a - b)
      const score = Math.round(values[Math.floor(values.length / 2)] * 100)
      if (score <= blockingScore) failures.push(`${path}의 ${categoryLabels[category]} ${score}점`)
      return score
    })
    return `| ${path} | ${scores.join(' | ')} |`
  })
  const verdict = failures.length
    ? [`${blockingScore}점 이하인 항목이 있어 병합을 차단합니다.`, '', ...failures.map((failure) => `- ${failure}`)]
    : [`모든 항목이 ${blockingScore}점을 넘어 점수 기준을 통과했습니다.`]
  const markdown = [
    '## Lighthouse 검사 결과',
    '',
    `각 화면을 모바일 기본 설정으로 3회 측정한 항목별 중앙값입니다. 항목 하나라도 ${blockingScore}점 이하이면 병합을 차단합니다.`,
    '',
    '| 경로 | 성능 | 접근성 | 권장사항 | SEO |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...verdict,
    ''
  ].join('\n')
  return { markdown, failures }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.LIGHTHOUSE_REPORT_DIR || '.lighthouseci'
  const files = (await readdir(directory, { recursive: true })).filter(
    (file) => /(^|\/)lhr-.*\.json$/.test(file) || file.endsWith('/lighthouse.json')
  )
  const reports = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(`${directory}/${file}`, 'utf8')))
  )
  const { markdown, failures } = summarize(reports.filter((report) => typeof report.requestedUrl === 'string'))
  console.log(markdown)
  if (process.env.LIGHTHOUSE_RESULT_FILE) {
    await writeFile(process.env.LIGHTHOUSE_RESULT_FILE, failures.length ? 'failed\n' : 'passed\n')
  }
}
