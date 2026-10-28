import console from 'node:console'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  compareEvaluations,
  evaluate,
  summarizeEvaluation,
  type EvaluationConfig,
  type EvaluationReport
} from './index.ts'

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    output: { type: 'string' },
    baseline: { type: 'string' },
    repetitions: { type: 'string', default: '1' },
    'timeout-ms': { type: 'string', default: '60000' }
  }
})
if (!values.config || !values.output) throw new Error('--config and --output are required')
const baseline = values.baseline ? (JSON.parse(await readFile(values.baseline, 'utf8')) as EvaluationReport) : undefined
const config = (await import(pathToFileURL(resolve(values.config)).href)).default as EvaluationConfig
const report = await evaluate(config, {
  repetitions: Number(values.repetitions),
  timeoutMs: Number(values['timeout-ms'])
})
await writeFile(values.output, JSON.stringify(report, null, 2) + '\n')
console.table(
  summarizeEvaluation(report).map((row) => ({
    ...row,
    cost: row.cost ? `${row.cost.amount} ${row.cost.currency}` : 'unknown'
  }))
)
if (baseline) {
  console.log(JSON.stringify(compareEvaluations(baseline, report), null, 2))
}
// Quality failures belong in the report; infrastructure failures also fail the command.
if (report.results.some((result) => result.status === 'error' || result.status === 'timeout')) process.exitCode = 1
