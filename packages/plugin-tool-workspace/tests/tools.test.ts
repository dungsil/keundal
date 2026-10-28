import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import workspaceToolsPlugin from '@keundal/plugin-tool-workspace'
import gitWorkspacePlugin from '@keundal/plugin-workspace-git'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

test('공개 도구로 Worktree 생성·조회·검토·적용·삭제 흐름을 실행하고 잘못된 인자는 거부한다', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'keundal-workspace-tools-'))
  const cwd = join(root, 'repo')
  await mkdir(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  await writeFile(join(cwd, 'a.txt'), 'old\n')
  git('add', '.')
  git('commit', '-m', 'initial')
  const ctx = new Context()
  const service = await ctx.plugin(gitWorkspacePlugin, {
    cwd,
    worktreeRoot: join(root, 'tasks'),
    review: async () => true
  })
  const tools = await ctx.plugin(workspaceToolsPlugin)
  t.onTestFinished(async () => {
    await tools.dispose()
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const context = { threadId: 'thread', runId: 'run', toolCallId: 'call', signal: new AbortController().signal }
  const execute = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(await ctx.workspaceTools.tools.find((tool) => tool.name === name)!.execute(args, context))
  const task = await execute('git_create_worktree', { taskId: 'task' })
  expect((await execute('git_status', { taskId: 'task' })).changes).toEqual([])
  const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
  expect(await execute('git_apply_patch', { taskId: 'task', patch })).toEqual({ applied: true })
  expect(await readFile(join(task.path, 'a.txt'), 'utf8')).toBe('new\n')
  expect(await execute('git_diff', { taskId: 'task' })).toContain('+new')
  expect(await execute('git_diff', { taskId: 'task', staged: true })).toBe('')
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('old\n')
  for (const [name, args] of [
    ['git_status', { cwd: '/' }],
    ['git_diff', { staged: 'yes' }],
    ['git_apply_patch', { patch, approved: true }],
    ['git_create_worktree', {}],
    ['git_remove_worktree', { taskId: 1 }]
  ] as const)
    await expect(execute(name, args)).rejects.toThrow('invalid workspace tool arguments')
  await writeFile(join(task.path, 'a.txt'), 'old\n')
  expect(await execute('git_remove_worktree', { taskId: 'task' })).toEqual({ removed: true })
})
