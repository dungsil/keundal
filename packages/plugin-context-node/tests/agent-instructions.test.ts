import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ContextOptions } from '@keundal/context'
import type { RunAgentInput } from '@keundal/core'
import { createAgentInstructionsContext } from '@keundal/plugin-context-node'
import localFileSystemPlugin from '@keundal/plugin-fs-local'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keundal-context-'))
  const ctx = new Context()
  const fiber = await ctx.plugin(localFileSystemPlugin, { cwd: root })
  t.onTestFinished(async () => {
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(path.join(root, '.git'))
  const options = (request: RunAgentInput, signal?: AbortSignal): ContextOptions => ({
    step: 0,
    request,
    ...(signal ? { signal } : {})
  })
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    tools: [],
    forwardedProps: {},
    messages: [{ id: 'user', role: 'user', content: '작업 지침을 확인해 주세요.' }]
  }
  return { root, fs: ctx.fs, input, options }
}

test('초기 지침 체인을 넓은 범위부터 읽고 같은 내용을 한 번만 추가한다', async (t) => {
  const { root, fs, input, options } = await setup(t)
  const cwd = path.join(root, 'child')
  await mkdir(cwd)
  await writeFile(path.join(root, 'AGENTS.md'), 'root guidance')
  await writeFile(path.join(root, 'CLAUDE.md'), ' root guidance \n')
  await writeFile(path.join(cwd, 'AGENTS.md'), 'child guidance')
  const provider = createAgentInstructionsContext(fs, { cwd, userGlobalPaths: [], maxBytes: 4096 })
  const result = await provider(input, options(input))
  expect(await provider(result, options(result))).toBe(result)
  const content = String(result.messages.at(-1)?.content)
  expect(content.indexOf('root guidance')).toBeLessThan(content.indexOf('child guidance'))
  expect(content.match(/root guidance/g)).toHaveLength(1)
  expect(result.threadId).toBe(input.threadId)
  expect(result.runId).toBe(input.runId)
})

test('이력 기준으로 파일 변경과 삭제를 알린다', async (t) => {
  const { root, fs, input, options } = await setup(t)
  const file = path.join(root, 'AGENTS.md')
  await writeFile(file, 'old guidance')
  const provider = createAgentInstructionsContext(fs, { cwd: root, userGlobalPaths: [], maxBytes: 4096 })
  const baseline = await provider(input, options(input))
  await writeFile(file, 'new guidance')
  const changed = await provider(baseline, options(baseline))
  expect(changed.messages.at(-1)?.content).toContain('Updated instructions from: AGENTS.md')
  await rm(file)
  const removed = await provider(changed, options(changed))
  expect(removed.messages.at(-1)?.content).toContain('Instructions removed: AGENTS.md')
})

test('바이트 예산에서 구체적인 파일을 우선하고 원본 크기를 제한한다', async (t) => {
  const { root, fs, input, options } = await setup(t)
  await writeFile(path.join(root, 'AGENTS.md'), 'b'.repeat(1000))
  await writeFile(path.join(root, 'CLAUDE.md'), 'c'.repeat(2000))
  await mkdir(path.join(root, 'deep'))
  await writeFile(path.join(root, 'deep', 'AGENTS.md'), 'specific')
  const provider = createAgentInstructionsContext(fs, {
    cwd: path.join(root, 'deep'),
    userGlobalPaths: [],
    maxBytes: 1024,
    maxSourceBytes: 1500
  })
  const result = await provider(input, options(input))
  const content = String(result.messages.at(-1)?.content)
  expect(content).toContain('specific')
  expect(content).not.toContain('b'.repeat(50))
  expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(1024)
})

test('성공한 파일 도구 호출로 하위 지침 파일을 발견한다', async (t) => {
  const { root, fs, input, options } = await setup(t)
  const nested = path.join(root, 'nested')
  await mkdir(nested)
  await writeFile(path.join(nested, 'AGENTS.md'), 'nested rules')
  await writeFile(path.join(root, 'AGENTS.md'), 'root guidance')
  const provider = createAgentInstructionsContext(fs, { cwd: root, userGlobalPaths: [], maxBytes: 4096 })
  const baseline = await provider(input, options(input))
  const toolInput: RunAgentInput = {
    ...baseline,
    messages: [
      ...baseline.messages,
      {
        id: 'assistant',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: path.join(nested, 'file.txt') }) }
          }
        ]
      },
      { id: 'tool', role: 'tool', toolCallId: 'call', content: 'read ok' }
    ]
  }
  const result = await provider(toolInput, options(toolInput))
  expect(result.messages.at(-1)?.content).toContain('Additional instructions from: nested/AGENTS.md')
})

test('취소된 요청은 파일을 읽기 전에 중단한다', async (t) => {
  const { root, fs, input, options } = await setup(t)
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const provider = createAgentInstructionsContext(fs, { cwd: root, userGlobalPaths: [] })
  await expect(provider(input, options(input, controller.signal))).rejects.toThrow('cancelled')
})
