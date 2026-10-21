import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import config from './lighthouserc.cjs'

const categories = ['performance', 'accessibility', 'best-practices', 'seo']

export function summarize(reports, collect = config.ci.collect) {
  const rows = collect.url.map((url) => {
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
      return Math.round(values[Math.floor(values.length / 2)] * 100)
    })
    return `| ${new URL(url).pathname} | ${scores.join(' | ')} |`
  })
  return [
    '## Lighthouse 검사 결과',
    '',
    '각 화면을 모바일 기본 설정으로 3회 측정한 항목별 중앙값입니다. 점수 기준으로 병합을 차단하지 않습니다.',
    '',
    '| 경로 | 성능 | 접근성 | 권장사항 | SEO |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = '.lighthouseci'
  const files = (await readdir(directory)).filter((file) => /^lhr-.*\.json$/.test(file))
  const reports = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(`${directory}/${file}`, 'utf8')))
  )
  console.log(summarize(reports))
}
