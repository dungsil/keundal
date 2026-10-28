import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import gitWorkspacePlugin from '@keundal/plugin-workspace-git'
import type { WorkspaceReviewer } from '@keundal/workspace'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const original = 'one\nmiddle\nlast\n'
const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-one\n+two\n middle\n last\n'

async function setup(t: TestContext, review?: WorkspaceReviewer, empty = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'keundal-workspace-')))
  const cwd = join(root, 'repo')
  await mkdir(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  if (!empty) {
    await writeFile(join(cwd, 'a.txt'), original)
    git('add', '.')
    git('commit', '-m', 'initial')
  }
  const ctx = new Context()
  const fiber = await ctx.plugin(gitWorkspacePlugin, { cwd, worktreeRoot: join(root, 'tasks'), review })
  t.onTestFinished(async () => {
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { workspace: ctx.workspace, cwd, git, fiber, root }
}

test('staged·unstaged·새 파일과 이름 변경을 구분하고 각 Diff를 조회한다', async (t) => {
  const { workspace, cwd, git } = await setup(t)
  git('mv', 'a.txt', 'renamed file.txt')
  await writeFile(join(cwd, 'renamed file.txt'), 'unstaged\nmiddle\nlast\n')
  await writeFile(join(cwd, '새 파일.txt'), 'new\n')
  expect(await workspace.status()).toEqual({
    path: cwd,
    branch: 'main',
    changes: [
      { path: 'renamed file.txt', previousPath: 'a.txt', index: 'R', workingTree: 'M' },
      { path: '새 파일.txt', index: '?', workingTree: '?' }
    ]
  })
  expect(await workspace.diff()).toContain('+unstaged')
  expect(await workspace.diff({ staged: true })).toContain('rename from a.txt')
  expect(await workspace.diff({ staged: true })).not.toContain('+unstaged')
})

test('커밋이 없는 저장소도 상태와 빈 Diff를 반환한다', async (t) => {
  const { workspace, cwd } = await setup(t, undefined, true)
  expect(await workspace.status()).toEqual({ path: cwd, branch: 'main', changes: [] })
  expect(await workspace.diff({ staged: true })).toBe('')
})

test('승인 전에 원본과 패치를 검토하고 승인 후 index를 바꾸지 않고 적용한다', async (t) => {
  const { workspace, cwd, git } = await setup(t, async (review) => {
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe(original)
    expect(review).toMatchObject({ operation: 'apply', path: cwd, patch })
    if (review.operation === 'apply') expect(review.summary).toContain('1 insertion(+)')
    return true
  })
  await workspace.applyPatch(patch)
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('two\nmiddle\nlast\n')
  expect(git('diff', '--cached')).toBe('')
})

test('승인 미설정과 거절은 원본을 보존하고 모델이 승인을 대신할 수 없다', async (t) => {
  for (const review of [undefined, async () => false]) {
    const { workspace, cwd } = await setup(t, review)
    await expect(workspace.applyPatch(patch)).rejects.toThrow('not approved')
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe(original)
    await expect(workspace.createWorktree('denied')).rejects.toThrow('not approved')
  }
})

test('검토 중 문맥 밖의 대상 내용이 바뀌어도 오래된 승인을 적용하지 않는다', async (t) => {
  const { workspace, cwd } = await setup(t, async () => {
    await writeFile(join(cwd, 'a.txt'), `${original}external change\n`)
    return true
  })
  await expect(workspace.applyPatch(patch)).rejects.toThrow('changed during review')
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe(`${original}external change\n`)
})

test('여러 파일 패치가 충돌하면 일부 파일도 적용하지 않는다', async (t) => {
  const { workspace, cwd } = await setup(t, async () => true)
  const invalid = patch + patch.replaceAll('a.txt', 'missing.txt')
  await expect(workspace.applyPatch(invalid)).rejects.toThrow()
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe(original)
})

test('이름 변경·복사 패치의 원본과 대상을 모두 검토하고 원본이 바뀌면 거부한다', async (t) => {
  const { workspace, cwd } = await setup(t, async () => true)
  const rename =
    'diff --git a/a.txt b/renamed file.txt\nsimilarity index 100%\nrename from a.txt\nrename to renamed file.txt\n'
  await workspace.applyPatch(rename)
  expect(await readFile(join(cwd, 'renamed file.txt'), 'utf8')).toBe(original)
  await expect(readFile(join(cwd, 'a.txt'))).rejects.toThrow()
  const copy =
    'diff --git a/renamed file.txt b/copy.txt\nsimilarity index 100%\ncopy from renamed file.txt\ncopy to copy.txt\n'
  await workspace.applyPatch(copy)
  expect(await readFile(join(cwd, 'renamed file.txt'), 'utf8')).toBe(original)
  expect(await readFile(join(cwd, 'copy.txt'), 'utf8')).toBe(original)
  const stale = await setup(t, async () => {
    await writeFile(join(stale.cwd, 'a.txt'), `${original}changed\n`)
    return true
  })
  // 별도의 rename 헤더 없이도 Git은 서로 다른 ---/+++ 경로를 이름 변경으로 해석합니다.
  const implicitRename = patch.replace('b/a.txt', 'b/destination.txt').replace('+++ b/a.txt', '+++ b/destination.txt')
  await expect(stale.workspace.applyPatch(implicitRename)).rejects.toThrow('changed during review')
  expect(await readFile(join(stale.cwd, 'a.txt'), 'utf8')).toBe(`${original}changed\n`)
  await expect(readFile(join(stale.cwd, 'destination.txt'))).rejects.toThrow()
})

test('공백과 탭이 있는 새 파일을 검토 후 만들고 삭제 패치도 적용한다', async (t) => {
  const { workspace, cwd } = await setup(t, async () => true)
  const added =
    'diff --git "a/new\\tfile.txt" "b/new\\tfile.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/new\\tfile.txt"\n@@ -0,0 +1 @@\n+hello\n'
  await workspace.applyPatch(added)
  expect(await readFile(join(cwd, 'new\tfile.txt'), 'utf8')).toBe('hello\n')
  const deleted =
    'diff --git a/a.txt b/a.txt\ndeleted file mode 100644\n--- a/a.txt\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-one\n-middle\n-last\n'
  await workspace.applyPatch(deleted)
  expect((await workspace.status()).changes).toContainEqual({ path: 'a.txt', index: ' ', workingTree: 'D' })
})

test('작업별 Worktree는 HEAD를 공유하되 파일과 index는 서로 격리한다', async (t) => {
  const { workspace, cwd } = await setup(t, async () => true)
  await writeFile(join(cwd, 'a.txt'), 'main dirty\n')
  const first = await workspace.createWorktree('task-1')
  const second = await workspace.createWorktree('task-2')
  expect(await workspace.status({ taskId: first.taskId })).toEqual({ path: first.path, branch: null, changes: [] })
  await workspace.applyPatch(patch, { taskId: first.taskId })
  expect(await readFile(join(first.path, 'a.txt'), 'utf8')).toBe('two\nmiddle\nlast\n')
  expect(await readFile(join(second.path, 'a.txt'), 'utf8')).toBe(original)
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('main dirty\n')
  await expect(workspace.removeWorktree(first.taskId)).rejects.toThrow()
  await workspace.removeWorktree(second.taskId)
  await expect(workspace.status({ taskId: second.taskId })).rejects.toThrow('unknown task')
  await expect(workspace.createWorktree('../escape')).rejects.toThrow('taskId')
  await expect(workspace.createWorktree(first.taskId)).rejects.toThrow('already exists')
})

test('새 파일·무시된 파일·새 커밋이 남은 Worktree의 삭제를 거부한다', async (t) => {
  const { workspace } = await setup(t, async () => true)
  const task = await workspace.createWorktree('new-files')
  await writeFile(join(task.path, 'untracked.txt'), 'keep me')
  await expect(workspace.removeWorktree(task.taskId)).rejects.toThrow()
  expect(await readFile(join(task.path, 'untracked.txt'), 'utf8')).toBe('keep me')
  const ignored = await workspace.createWorktree('ignored')
  await writeFile(join(ignored.path, '.gitignore'), 'local.txt\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ignored.path, encoding: 'utf8' })
  git('add', '.gitignore')
  git('commit', '-m', 'ignore local')
  await writeFile(join(ignored.path, 'local.txt'), 'private data')
  await expect(workspace.removeWorktree(ignored.taskId)).rejects.toThrow('ignored files')
  expect(await readFile(join(ignored.path, 'local.txt'), 'utf8')).toBe('private data')
  await rm(join(ignored.path, 'local.txt'))
  await expect(workspace.removeWorktree(ignored.taskId)).rejects.toThrow('HEAD changed')
  expect(git('log', '-1', '--format=%s').trim()).toBe('ignore local')
})

test('저장소 밖 경로·Git 메타데이터·새 심볼릭 링크를 패치하지 않는다', async (t) => {
  const { workspace, cwd, root } = await setup(t, async () => true)
  await writeFile(join(root, 'outside.txt'), original)
  for (const file of ['../outside.txt', '.git/config']) {
    await expect(workspace.applyPatch(patch.replaceAll('a.txt', file))).rejects.toThrow()
  }
  const link =
    'diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+../outside.txt\n\\ No newline at end of file\n'
  await expect(workspace.applyPatch(link)).rejects.toThrow('symlink')
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe(original)
  expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe(original)
})

test('Worktree 생성 승인은 검토한 HEAD에만 적용한다', async (t) => {
  const { workspace, cwd, git } = await setup(t, async (review) => {
    if (review.operation === 'createWorktree') {
      expect(review.head).toBe(initial)
      await writeFile(join(cwd, 'a.txt'), 'later commit\n')
      git('add', '.')
      git('commit', '-m', 'later')
    }
    return true
  })
  const initial = git('rev-parse', 'HEAD').trim()
  const task = await workspace.createWorktree('pinned')
  expect(await readFile(join(task.path, 'a.txt'), 'utf8')).toBe(original)
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('later commit\n')
})

test('승인 대기 중 취소하거나 플러그인을 해제하면 나중에 승인되어도 적용하지 않는다', async (t) => {
  for (const dispose of [false, true]) {
    let entered!: () => void
    const reviewing = new Promise<void>((accept) => {
      entered = accept
    })
    let approve!: (value: boolean) => void
    const { workspace, cwd, fiber } = await setup(t, () => {
      entered()
      return new Promise<boolean>((accept) => {
        approve = accept
      })
    })
    const controller = new AbortController()
    const pending = workspace.applyPatch(patch, { signal: controller.signal })
    const assertion = expect(pending).rejects.toThrow()
    await reviewing
    if (dispose) await fiber.dispose()
    else controller.abort(new Error('cancelled'))
    await assertion
    approve(true)
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe(original)
  }
})

test('Worktree를 만들 때 저장소의 smudge·process 필터를 실행하지 않는다', async (t) => {
  const { workspace, cwd, git, root } = await setup(t, async () => true)
  await writeFile(join(cwd, '.gitattributes'), 'a.txt filter=unsafe\n')
  git('add', '.gitattributes')
  git('commit', '-m', 'attributes')
  const marker = join(root, 'filter-executed')
  git('config', 'filter.unsafe.smudge', `touch '${marker}'; cat`)
  git('config', 'filter.unsafe.process', `touch '${marker}'; exit 1`)
  git('config', 'filter.unsafe.required', 'true')
  const task = await workspace.createWorktree('safe-checkout')
  expect(await readFile(join(task.path, 'a.txt'), 'utf8')).toBe(original)
  await expect(readFile(marker)).rejects.toThrow()
})
