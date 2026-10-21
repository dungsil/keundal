import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunAgentInput } from '@keundal/core'
import { createFileReferenceContext } from '@keundal/plugin-context'
import { LocalFileReferenceService, type LocalFileReferenceConfig } from '@keundal/plugin-context-node'
import { Context } from 'cordis'
import { afterEach, expect, test } from 'vitest'

const fixture: RunAgentInput = {
  threadId: 'current',
  runId: 'run',
  state: {},
  context: [],
  messages: [],
  tools: [],
  forwardedProps: {}
}
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test('경로만 정렬해 반환하고 숨김·제외 디렉터리·결과 수·취소를 적용한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keundal-references-'))
  directories.push(root)
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'src', 'some file.ts'), 'secret file contents')
  await writeFile(join(root, 'src', 'sample.ts'), 'another secret')
  await writeFile(join(root, '.hidden'), 'hidden')
  await writeFile(join(root, 'node_modules', 'excluded.js'), 'excluded')
  const ctx = new Context()
  const service = new LocalFileReferenceService(ctx, { root, maxResults: 1 } satisfies LocalFileReferenceConfig)
  const quoted = await service.list('src/s')
  expect(await service.list('src/zzz')).toEqual([])
  expect(quoted).toEqual([{ path: 'src/sample.ts', kind: 'file' }])
  expect(await service.list('secret')).toEqual([])
  expect((await service.list('')).some((candidate) => candidate.path === 'node_modules')).toBe(false)
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  await expect(service.list('src/', controller.signal)).rejects.toThrow()
  await expect(service.list('src/')).resolves.toHaveLength(1)
})

test('도구 후속 단계에서 새 파일을 경로 완성에 반영한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keundal-reference-refresh-'))
  directories.push(root)
  const service = new LocalFileReferenceService(new Context(), { root })
  expect(await service.list('new')).toEqual([])
  await writeFile(join(root, 'new.ts'), 'created by a tool')
  await createFileReferenceContext(service)(fixture, { step: 2, request: fixture })
  expect(await service.list('new')).toEqual([{ path: 'new.ts', kind: 'file' }])
})
