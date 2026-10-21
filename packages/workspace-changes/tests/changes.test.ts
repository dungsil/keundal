import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, unlink, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventType, type LLMEvent } from '@keundal/core'
import { recordWorkspaceChanges } from '@keundal/workspace-changes'
import { compareLines, type WorkspaceChanges } from '@keundal/workspace-changes/shared'
import { expect, test, type TestContext } from 'vitest'

async function repo(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'keundal-changes-'))
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', cwd])
  await writeFile(join(cwd, 'file.txt'), 'committed\n')
  execFileSync('git', ['add', '.'], { cwd })
  await writeFile(join(cwd, 'file.txt'), 'user edit\n')
  return cwd
}
async function record(cwd: string, mutate: () => Promise<void>, options = {}) {
  async function* source(): AsyncGenerator<LLMEvent> {
    await mutate()
    yield { type: EventType.TOOL_CALL_RESULT, messageId: 'm', toolCallId: 'c', role: 'tool', content: '{}' }
  }
  const events = []
  for await (const event of recordWorkspaceChanges({ cwd, ...options })(source(), { threadId: 't', runId: 'r' }))
    events.push(event)
  return events.filter((e) => e.type === EventType.CUSTOM).map((e) => e.value as WorkspaceChanges)
}

test('턴 시작의 미커밋 내용을 기준으로 생성·수정·삭제를 기록하고 Git index를 보존한다', async (t) => {
  const cwd = await repo(t)
  await writeFile(join(cwd, 'deleted.txt'), 'gone\n')
  const index = await readFile(join(cwd, '.git/index'))
  const records = await record(cwd, async () => {
    await writeFile(join(cwd, 'file.txt'), 'agent edit\nextra\n')
    await writeFile(join(cwd, 'new.txt'), 'new\n')
    await unlink(join(cwd, 'deleted.txt'))
  })
  expect(records.at(-1)).toMatchObject({
    runId: 'r',
    status: 'complete',
    files: [
      { path: 'deleted.txt', kind: 'deleted', before: 'gone\n', after: null, additions: 0, deletions: 1 },
      {
        path: 'file.txt',
        kind: 'modified',
        before: 'user edit\n',
        after: 'agent edit\nextra\n',
        additions: 2,
        deletions: 1
      },
      { path: 'new.txt', kind: 'added', before: null, after: 'new\n', additions: 1, deletions: 0 }
    ]
  })
  expect(await readFile(join(cwd, '.git/index'))).toEqual(index)
})

test('같은 파일을 여러 번 바꿔도 처음과 마지막만 비교하고 원상 복구는 제외한다', async (t) => {
  const cwd = await repo(t)
  const records = await record(cwd, async () => {
    await writeFile(join(cwd, 'file.txt'), 'temporary\n')
    await writeFile(join(cwd, 'file.txt'), 'user edit\n')
  })
  expect(records.at(-1)?.files).toEqual([])
})

test('무시된 파일과 외부 링크의 내용을 읽지 않고 바이너리·대용량은 사유를 기록한다', async (t) => {
  const cwd = await repo(t)
  await writeFile(join(cwd, '.gitignore'), 'ignored.txt\n')
  const records = await record(
    cwd,
    async () => {
      await writeFile(join(cwd, 'ignored.txt'), 'hidden')
      await symlink('/etc/passwd', join(cwd, 'link'))
      await writeFile(join(cwd, 'binary'), Buffer.from([0, 1]))
      await writeFile(join(cwd, 'large'), 'a'.repeat(100))
    },
    { maxFileBytes: 32 }
  )
  expect(records.at(-1)?.files.map((f) => [f.path, f.reason])).toEqual([
    ['binary', 'binary'],
    ['large', 'oversized'],
    ['link', 'unsupported']
  ])
  expect(JSON.stringify(records)).not.toContain('root:')
})

test('Git이 없는 디렉터리는 변경 없음 대신 기록 불가로 표시한다', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'keundal-no-git-'))
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  const records = await record(cwd, async () => {})
  expect(records.at(-1)).toMatchObject({ status: 'unavailable', files: [] })
})

test('빈 파일과 마지막 개행 변경을 구분하고 줄 번호를 계산한다', () => {
  expect(compareLines('', '').additions).toBe(0)
  expect(compareLines('a\n', 'a')).toMatchObject({ additions: 1, deletions: 1 })
  expect(compareLines('a\nb\n', 'a\nc\n').rows).toEqual([
    { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { kind: 'deleted', text: 'b', oldLine: 2 },
    { kind: 'added', text: 'c', newLine: 2 }
  ])
})

test('파일 수 제한을 넘으면 불완전한 삭제 목록 대신 기록 불가로 표시한다', async (t) => {
  const cwd = await repo(t)
  const records = await record(
    cwd,
    async () => {
      await writeFile(join(cwd, 'new'), 'new')
    },
    { maxFiles: 1 }
  )
  expect(records.at(-1)).toMatchObject({ status: 'unavailable', files: [] })
})

test('후속 생성이 실패해도 이미 바뀐 파일을 부분 기록으로 전달한다', async (t) => {
  const cwd = await repo(t)
  async function* source(): AsyncGenerator<LLMEvent> {
    await writeFile(join(cwd, 'file.txt'), 'changed\n')
    yield { type: EventType.CUSTOM, name: 'test-progress', value: null }
    throw new Error('provider failed')
  }
  const events: LLMEvent[] = []
  await expect(
    (async () => {
      for await (const event of recordWorkspaceChanges({ cwd })(source(), { threadId: 't', runId: 'r' }))
        events.push(event)
    })()
  ).rejects.toThrow('provider failed')
  expect(events.at(-1)).toMatchObject({
    type: EventType.CUSTOM,
    value: { status: 'partial', files: [{ path: 'file.txt' }] }
  })
})

test('턴 중 무시 규칙이 바뀌어도 기존 파일을 삭제로 오인하지 않는다', async (t) => {
  const cwd = await repo(t)
  await writeFile(join(cwd, 'keep.txt'), 'keep\n')
  const records = await record(cwd, async () => {
    await writeFile(join(cwd, '.gitignore'), 'keep.txt\n')
  })
  expect(records.at(-1)?.files.map((file) => file.path)).toEqual(['.gitignore'])
})

test('각 스냅샷의 파일 수가 한도 이하여도 합친 변경 목록이 넘으면 기록 불가로 표시한다', async (t) => {
  const cwd = await repo(t)
  await writeFile(join(cwd, 'old'), 'old')
  const records = await record(
    cwd,
    async () => {
      await unlink(join(cwd, 'old'))
      await writeFile(join(cwd, 'new'), 'new')
    },
    { maxFiles: 2 }
  )
  expect(records.at(-1)).toMatchObject({ status: 'unavailable', files: [] })
})

test('무시 규칙에서 빠진 기존 파일을 새 파일로 오인하지 않는다', async (t) => {
  const cwd = await repo(t)
  await writeFile(join(cwd, '.gitignore'), 'hidden\n')
  await writeFile(join(cwd, 'hidden'), 'existing')
  const records = await record(cwd, async () => {
    await writeFile(join(cwd, '.gitignore'), '')
  })
  expect(records.at(-1)?.files.find((file) => file.path === 'hidden')).toEqual({
    path: 'hidden',
    kind: 'modified',
    reason: 'baseline'
  })
})
