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

export function summarize(reports, collect = config.ci.collect, budgets = config.ci.budgets) {
  for (const name of ['performance', 'accessibility', 'cls']) {
    const value = budgets[name]
    if (!Number.isFinite(value) || value < 0 || (name !== 'cls' && value > 100)) {
      throw new Error(`Invalid Lighthouse budget: ${name}`)
    }
  }
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
      if (score < (budgets[category] ?? blockingScore + 1))
        failures.push(`${path}의 ${categoryLabels[category]} ${score}점`)
      return score
    })
    const shifts = runs.map((report) => report.audits?.['cumulative-layout-shift']?.numericValue)
    if (shifts.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${url}: missing cumulative-layout-shift value`)
    }
    shifts.sort((a, b) => a - b)
    const cls = shifts[Math.floor(shifts.length / 2)]
    if (cls > budgets.cls) failures.push(`${path}의 CLS ${cls} (최대 ${budgets.cls})`)
    return `| ${path} | ${scores.join(' | ')} | ${cls.toFixed(3)} |`
  })
  const verdict = failures.length
    ? ['예산을 초과한 항목이 있어 병합을 차단합니다.', '', ...failures.map((failure) => `- ${failure}`)]
    : ['모든 항목이 점수와 CLS 기준을 통과했습니다.']
  const markdown = [
    '## Lighthouse 검사 결과',
    '',
    `각 화면을 모바일 기본 설정으로 ${collect.numberOfRuns}회 측정한 중앙값입니다. 성능 ${budgets.performance}점 이상, 접근성 ${budgets.accessibility}점 이상, 나머지 항목 ${blockingScore + 1}점 이상, CLS ${budgets.cls} 이하를 요구합니다. 이 값은 측정된 기준선이 아닌 초기 정책 예산입니다.`,
    '',
    '| 경로 | 성능 | 접근성 | 권장사항 | SEO | CLS |',
    '| --- | --- | --- | --- | --- | --- |',
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
