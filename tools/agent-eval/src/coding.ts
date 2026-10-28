import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import type { ExecutableTool } from '@keundal/tools'

import type { EvaluationScenario } from './index.ts'

const runFile = promisify(execFile)
const filename = 'solution.mjs'
const success = 'Assertions passed\n'

function validate(args: Record<string, unknown>, keys: readonly string[]): void {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(args, key) || typeof args[key] !== 'string') ||
    args.path !== filename
  ) {
    throw new Error('Expected only solution.mjs and the documented string arguments')
  }
}

function codingScenario(id: string, prompt: string, initial: string, assertions: string): EvaluationScenario {
  return {
    id,
    version: '1',
    async prepare() {
      let solution = initial
      const tools: readonly ExecutableTool[] = [
        {
          name: 'read_file',
          description: 'Read solution.mjs, the only available file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', enum: [filename] } },
            required: ['path'],
            additionalProperties: false
          },
          execute(args) {
            validate(args, ['path'])
            return solution
          }
        },
        {
          name: 'write_file',
          description: 'Replace the complete contents of solution.mjs, the only writable file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', enum: [filename] },
              content: { type: 'string' }
            },
            required: ['path', 'content'],
            additionalProperties: false
          },
          execute(args) {
            validate(args, ['path', 'content'])
            solution = args.content as string
            return 'Updated solution.mjs'
          }
        }
      ]

      return {
        prompt,
        tools,
        async verify() {
          const directory = await mkdtemp(join(tmpdir(), 'keundal-coding-eval-'))
          try {
            await Promise.all([
              writeFile(join(directory, filename), solution, 'utf8'),
              writeFile(
                join(directory, 'assertions.mjs'),
                `import assert from 'node:assert/strict'\n${assertions}\nprocess.stdout.write(${JSON.stringify(success)})\n`,
                'utf8'
              )
            ])
            // Generated code is untrusted. This subprocess is NOT an OS sandbox:
            // Node permissions are defense in depth, not isolation from malicious code or the network.
            // Do not inherit environment secrets; bound runtime, file access and captured output.
            const result = await runFile(
              process.execPath,
              ['--permission', `--allow-fs-read=${directory}`, 'assertions.mjs'],
              {
                cwd: directory,
                env: {},
                timeout: 3_000,
                killSignal: 'SIGKILL',
                maxBuffer: 64 * 1024,
                encoding: 'utf8'
              }
            )
            return result.stdout === success
          } catch {
            return false
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        },
        async dispose() {
          // verify() owns and removes each temporary directory; nothing is retained.
        }
      }
    }
  }
}

export const codingScenarios: EvaluationScenario[] = [
  codingScenario(
    'coding-slug',
    `Implement the named export slug(text) in solution.mjs using the file tools.
The input is a string. Convert ASCII A-Z to lowercase, replace each consecutive run
of characters other than ASCII letters and digits with one hyphen, and remove
leading and trailing hyphens. Non-ASCII characters are separators, not transliterated.
Return the resulting string, including an empty string when no letters or digits remain.
Do not add dependencies or other files.`,
    `export function slug(text) {\n  return ''\n}\n`,
    `import { slug } from './solution.mjs'
for (const [input, expected] of [
  ['Hello World', 'hello-world'],
  ['  API__v2...Ready!?  ', 'api-v2-ready'],
  ['left---RIGHT_9', 'left-right-9'],
  ['A/B\\\\C\\tD\\nE', 'a-b-c-d-e'],
  ['déjà vu', 'd-j-vu'],
  ['한글 A 42 끝', 'a-42'],
  ['0', '0'],
  ['already-clean-123', 'already-clean-123'],
  ['---___!!!', ''],
  ['', '']
]) assert.equal(slug(input), expected)`
  ),
  codingScenario(
    'coding-median',
    `Implement the named export median(values) in solution.mjs using the file tools.
The input is an array of finite numbers. Return the middle value after numeric ascending
sorting for odd lengths, or the arithmetic mean of the two middle values for even lengths.
Return null for an empty array. Do not mutate the input array. The mean of two finite
middle values must remain finite, including when both are very large.
Do not add dependencies or other files.`,
    `export function median(values) {\n  return null\n}\n`,
    `import { median } from './solution.mjs'
for (const [input, expected] of [
  [[], null],
  [[7], 7],
  [[10, 2, 1], 2],
  [[9, 1, 2, 100], 5.5],
  [[-8, -2, -11, -4, -3], -4],
  [[-5, 8, 0, 2], 1],
  [[4, 4, 1, 9, 4, 2], 4],
  [[1.5, -0.5, 3.5, 0.5], 1],
  [[1e308, 1e308], 1e308],
  [[-1e308, 1e308], 0],
  [[Number.MIN_VALUE, Number.MIN_VALUE], Number.MIN_VALUE]
]) {
  const original = [...input]
  assert.equal(median(input), expected)
  assert.deepEqual(input, original)
}`
  )
]
