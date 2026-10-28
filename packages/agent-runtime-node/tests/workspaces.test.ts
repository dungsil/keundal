import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentApp } from '@keundal/agent-host/http'
import type { CodingWorkspaceClient } from '@keundal/workspace'
import { expect, test, type TestContext } from 'vitest'

import { createNodeAgentHost, createNodeComposition } from '../src/index.js'

async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'keundal-coding-host-')))
  const hosts: Awaited<ReturnType<typeof createNodeAgentHost>>[] = []
  t.onTestFinished(async () => {
    for (const host of hosts) await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  async function repository(name: string) {
    const path = join(root, name)
    await mkdir(path)
    git(path, 'init', '-b', 'main')
    git(path, 'config', 'user.email', 'test@example.com')
    git(path, 'config', 'user.name', 'Test')
    git(path, 'config', 'core.autocrlf', 'false')
    await writeFile(join(path, 'a.txt'), 'original\n')
    await writeFile(join(path, 'delete.txt'), 'delete me\n')
    git(path, 'add', '.')
    git(path, 'commit', '-m', 'initial')
    return path
  }
  const provider = join(root, 'llm.mjs')
  await writeFile(
    provider,
    `export default ctx => ctx.provide('llm', {
    async getModel() { return { contextWindow: 128000, maxOutputTokens: 4096 } },
    async countTokens() { return 10 },
    async *stream(request) {
      const messages = request.input.messages
      const userIndex = messages.findLastIndex(m => m.role === 'user')
      const user = messages[userIndex]
      const steps = JSON.parse(user.content)
      const results = messages.slice(userIndex + 1).filter(m => m.role === 'tool')
      const step = steps[results.length]
      if (step) {
        const id = request.input.runId + '-' + results.length
        yield { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: step.name }
        yield { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(step.args) }
        yield { type: 'TOOL_CALL_END', toolCallId: id }
      } else {
        const id = request.input.runId + '-answer'
        yield { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' }
        yield { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: JSON.stringify({ tools: request.tools?.map(t => t.name) ?? request.input.tools.map(t => t.name), system: messages.filter(m => m.role === 'system').map(m => m.content), results: results.map(m => m.content) }) }
        yield { type: 'TEXT_MESSAGE_END', messageId: id }
      }
    }
  })`
  )
  async function host(model = 'fixture') {
    const host = await createNodeAgentHost(
      {
        provider: 'fixture',
        apiKey: '',
        model,
        sqlitePath: join(root, 'store.sqlite'),
        workspaceRoot: join(root, 'workspaces'),
        runtimePlugins: {
          plugins: [{ module: provider }, { module: 'builtin:store' }],
          agent: { module: 'builtin:agent', config: { subagents: false } },
          tools: []
        }
      },
      createNodeComposition
    )
    hosts.push(host)
    return host
  }
  async function run(
    host: Awaited<ReturnType<typeof createNodeAgentHost>>,
    threadId: string,
    steps: { name: string; args: Record<string, string> }[] = []
  ) {
    const events = await Array.fromAsync(
      host.services.run({
        threadId,
        runId: randomUUID(),
        state: {},
        context: [],
        tools: [],
        messages: [{ id: randomUUID(), role: 'user', content: JSON.stringify(steps) }]
      })
    )
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
    const snapshot = await host.services.session.get(threadId)
    const answer = snapshot?.messages
      .filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('{'))
      .at(-1)
    return JSON.parse(answer?.content as string) as { tools: string[]; system: string[]; results: string[] }
  }
  return { root, repository, host, run, git }
}

test('ACP 매니페스트는 Worktree에서도 외부 에이전트를 선택하고 새 대화의 저장된 사용자 입력을 허용한다', async (t) => {
  const { root, repository } = await setup(t)
  const project = await repository('acp-project')
  const script = `
    let cwd;
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      let result;
      if (request.method === 'initialize') result = {protocolVersion:request.params.protocolVersion};
      if (request.method === 'session/new') {cwd=request.params.cwd; result={sessionId:'acp'};}
      if (request.method === 'session/prompt') {
        console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'acp',update:{
          sessionUpdate:'agent_message_chunk',content:{type:'text',text:cwd+'|'+process.cwd()}
        }}}));
        result={stopReason:'end_turn'};
      }
      console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
    });
  `
  const app = await createNodeAgentHost(
    {
      provider: 'openai',
      apiKey: 'unused',
      model: 'test',
      sqlitePath: join(root, 'acp.sqlite'),
      workspaceRoot: join(root, 'acp-workspaces'),
      runtimePlugins: {
        plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }],
        agent: { module: 'builtin:acp', config: { command: process.execPath, args: ['-e', script], cwd: project } },
        tools: []
      }
    },
    createNodeComposition
  )
  try {
    app.ctx.llm.stream = () => {
      throw new Error('local LLM must not generate ACP responses')
    }
    const workspace = await app.services.workspaces!.create('acp-thread', project)
    const message = { id: 'user', role: 'user' as const, content: 'inspect' }
    await app.services.session.commit({ threadId: 'acp-thread', expectedRevision: 0, messages: [message], state: {} })
    const events = await Array.fromAsync(
      app.services.run({
        threadId: 'acp-thread',
        runId: 'acp-run',
        messages: [message],
        state: {},
        context: [],
        tools: []
      })
    )
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
    expect(
      events
        .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
        .map((event) => event.delta)
        .join('')
    ).toBe(`${workspace.path}|${workspace.path}`)
    expect((await app.services.generation.get('acp-run'))?.status).toBe('completed')
  } finally {
    await app.dispose()
  }
})

test('프로젝트와 대화별 Worktree를 격리하고 일반 대화에는 코딩 도구를 제공하지 않는다', async (t) => {
  const { repository, host, run } = await setup(t)
  const first = await repository('first')
  const second = await repository('second')
  const app = await host()
  const client: CodingWorkspaceClient = app.services.workspaces!
  expect(await client.get('unknown')).toBeUndefined()
  expect((await run(app, 'a')).tools).not.toContain('write_file')
  const a = await client.create('a', first)
  const b = await client.create('b', second)
  const c = await client.create('c', first)
  expect(new Set([a.path, b.path, c.path]).size).toBe(3)
  await expect(client.create('a', second)).rejects.toThrow('another project')
  const result = await run(app, 'a', [
    { name: 'read_file', args: { path: 'a.txt' } },
    { name: 'edit_file', args: { path: 'a.txt', oldText: 'original', newText: 'coding' } }
  ])
  expect(result.tools).toEqual(['read_file', 'list_directory', 'write_file', 'edit_file'])
  expect(result.system.join('\n')).toContain('coding')
  expect(await readFile(join(a.path, 'a.txt'), 'utf8')).toBe('coding\n')
  for (const path of [first, second, b.path, c.path])
    expect(await readFile(join(path, 'a.txt'), 'utf8')).toBe('original\n')
  expect((await run(app, 'ordinary')).tools).not.toContain('write_file')
})

test('원본의 미커밋 변경은 작업으로 복사하지 않고 관련 없는 staged 변경을 보존한다', async (t) => {
  const { repository, host, git } = await setup(t)
  const project = await repository('repo')
  await writeFile(join(project, 'delete.txt'), 'user staged change\n')
  git(project, 'add', 'delete.txt')
  const staged = git(project, 'diff', '--cached')
  const client = (await host()).services.workspaces!
  const task = await client.create('thread', project)
  expect(await readFile(join(task.path, 'delete.txt'), 'utf8')).toBe('delete me\n')
  await writeFile(join(task.path, 'a.txt'), 'task edit\n')
  const review = await client.review('thread')
  await client.apply('thread', review.reviewId!)
  expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('task edit\n')
  expect(await readFile(join(project, 'delete.txt'), 'utf8')).toBe('user staged change\n')
  expect(git(project, 'diff', '--cached')).toBe(staged)
})

test('autocrlf 체크아웃은 초기 Diff에서 제외하고 CRLF 수정만 원본에 적용한다', async (t) => {
  const { repository, host, git } = await setup(t)
  const project = await repository('repo')
  git(project, 'config', 'core.autocrlf', 'true')
  await rm(join(project, 'a.txt'))
  await rm(join(project, 'delete.txt'))
  git(project, 'checkout', '--', '.')
  const client = (await host()).services.workspaces!
  const task = await client.create('thread', project)
  expect(await readFile(join(task.path, 'a.txt'), 'utf8')).toBe('original\r\n')
  expect(task.patch).toBe('')
  expect((await client.review('thread')).changes).toEqual([])
  await writeFile(join(task.path, 'a.txt'), 'edited\r\n')
  const review = await client.review('thread')
  expect(review.changes).toEqual([expect.objectContaining({ path: 'a.txt' })])
  expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('original\r\n')
  const applied = await client.apply('thread', review.reviewId!)
  expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('edited\r\n')
  expect(await readFile(join(project, 'delete.txt'), 'utf8')).toBe('delete me\r\n')
  expect(applied.patch).toBe('')
  expect(git(project, 'diff', '--cached')).toBe('')
})

test('전체 패치는 커밋한 수정과 새 파일·삭제를 포함하고 적용 후 후속 변경만 검토한다', async (t) => {
  const { repository, host, git } = await setup(t)
  const project = await repository('repo')
  const app = await host()
  const client = app.services.workspaces!
  const task = await client.create('thread', project)
  await writeFile(join(task.path, 'a.txt'), 'committed change\n')
  git(task.path, 'add', 'a.txt')
  git(task.path, 'commit', '-m', 'task edit')
  await writeFile(join(task.path, '새 파일.txt'), 'added\n')
  await rm(join(task.path, 'delete.txt'))
  const review = await client.review('thread')
  expect(review.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'a.txt', index: 'M' }),
      expect.objectContaining({ path: 'delete.txt', index: 'D' }),
      expect.objectContaining({ path: '새 파일.txt', index: 'A' })
    ])
  )
  expect(review.patch).toContain('+committed change')
  expect(review.patch).toContain('+added')
  expect(review.patch).toContain('-delete me')
  expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('original\n')
  const applied = await client.apply('thread', review.reviewId!)
  expect(applied.patch).toBe('')
  expect(applied.reviewId).toBeUndefined()
  expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('committed change\n')
  expect(await readFile(join(project, '새 파일.txt'), 'utf8')).toBe('added\n')
  await expect(readFile(join(project, 'delete.txt'))).rejects.toThrow()
  expect(git(project, 'diff', '--cached')).toBe('')
  await expect(client.apply('thread', review.reviewId!)).rejects.toThrow('expired')
  expect(git(project, 'for-each-ref', '--format=%(refname)', 'refs/keundal-workspaces/')).toContain('/base-')
  git(project, 'gc', '--prune=now')
  await writeFile(join(task.path, 'a.txt'), 'continued\n')
  const next = await client.review('thread')
  expect(next.patch).toContain('-committed change')
  expect(next.patch).toContain('+continued')
  expect(next.patch).not.toContain('delete me')
  await client.apply('thread', next.reviewId!)
  expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('continued\n')
})

test('검토 후 작업과 원본의 변경·다른 대화의 토큰·겹치는 원본 변경을 거부한다', async (t) => {
  const { repository, host } = await setup(t)
  const project = await repository('repo')
  const client = (await host()).services.workspaces!
  const task = await client.create('thread', project)
  await client.create('other', project)
  await writeFile(join(task.path, 'a.txt'), 'task\n')
  let review = await client.review('thread')
  await expect(client.apply('other', review.reviewId!)).rejects.toThrow('expired')
  await writeFile(join(task.path, 'a.txt'), 'new task\n')
  expect((await client.get('thread'))?.reviewId).toBeUndefined()
  await expect(client.apply('thread', review.reviewId!)).rejects.toThrow('changed after review')
  review = await client.review('thread')
  await writeFile(join(project, 'unrelated.txt'), 'external\n')
  await expect(client.apply('thread', review.reviewId!)).rejects.toThrow('changed after review')
  await writeFile(join(project, 'a.txt'), 'conflict\n')
  review = await client.review('thread')
  await expect(client.apply('thread', review.reviewId!)).rejects.toThrow('conflicts')
  expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('conflict\n')
})

test('호스트 재시작과 모델 변경 후 작업을 복구하고 이전 승인을 재사용하지 않는다', async (t) => {
  const { repository, host, run } = await setup(t)
  const project = await repository('repo')
  const first = await host()
  const task = await first.services.workspaces!.create('thread', project)
  await writeFile(join(task.path, 'new.txt'), 'preserve dirty worktree\n')
  const review = await first.services.workspaces!.review('thread')
  await first.dispose()
  const second = await host('different-model')
  const restored = await second.services.workspaces!.get('thread')
  expect(restored?.path).toBe(task.path)
  expect(restored?.patch).toContain('preserve dirty worktree')
  expect(restored?.reviewId).toBeUndefined()
  await expect(second.services.workspaces!.apply('thread', review.reviewId!)).rejects.toThrow('expired')
  expect((await run(second, 'thread')).tools).toContain('edit_file')
  const fresh = await second.services.workspaces!.review('thread')
  await second.services.workspaces!.apply('thread', fresh.reviewId!)
  await second.dispose()
  const third = await host()
  expect((await third.services.workspaces!.get('thread'))?.patch).toBe('')
})

test('코딩 파일 도구는 .git·상위 경로·다른 프로젝트·심볼릭 링크 탈출을 거부한다', async (t) => {
  const { repository, host, run } = await setup(t)
  const project = await repository('repo')
  const other = await repository('other')
  const app = await host()
  const task = await app.services.workspaces!.create('thread', project)
  await symlink(join(other, 'a.txt'), join(task.path, 'escape.txt'))
  await symlink('.git', join(task.path, 'metadata-link'))
  const metadata = await readFile(join(task.path, '.git'), 'utf8')
  const denied: { name: string; args: Record<string, string> }[] = [
    { name: 'read_file', args: { path: '.git' } },
    { name: 'read_file', args: { path: 'metadata-link' } },
    { name: 'write_file', args: { path: '.git', content: 'corrupt' } },
    { name: 'read_file', args: { path: '../outside.txt' } },
    { name: 'read_file', args: { path: join(project, 'a.txt') } },
    { name: 'read_file', args: { path: 'escape.txt' } }
  ]
  for (const step of denied) await expect(run(app, 'thread', [step])).rejects.toThrow(/metadata|outside allowed roots/)
  expect(await readFile(join(task.path, '.git'), 'utf8')).toBe(metadata)
  expect(await readFile(join(other, 'a.txt'), 'utf8')).toBe('original\n')
})

test('HTTP 작업 경로는 인증·생성·검토·적용과 의미 있는 오류를 제공한다', async (t) => {
  const { repository, host } = await setup(t)
  const project = await repository('repo')
  const app = await host()
  const server = createServer(createAgentApp(app.services, { token: 'test-token' }))
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept))
  t.onTestFinished(
    () => new Promise<void>((accept, reject) => server.close((error) => (error ? reject(error) : accept())))
  )
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/workspaces/http-thread`
  const request = (path = '', body?: unknown) =>
    fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  expect((await fetch(url)).status).toBe(401)
  expect((await request()).status).toBe(404)
  expect((await request('/review', {})).status).toBe(409)
  expect((await request('/apply', { reviewId: 'missing' })).status).toBe(409)
  expect((await request('', { projectPath: '' })).status).toBe(400)
  const created = await request('', { projectPath: project })
  expect(created.status).toBe(200)
  const task = (await created.json()) as { path: string }
  await writeFile(join(task.path, 'new.txt'), 'http change\n')
  const review = (await (await request('/review', {})).json()) as { reviewId: string }
  expect((await request('/apply', { reviewId: review.reviewId })).status).toBe(200)
  const expired = await request('/apply', { reviewId: review.reviewId })
  expect(expired.status).toBe(409)
  expect(await expired.json()).toMatchObject({ error: expect.stringContaining('expired') })
  expect(await readFile(join(project, 'new.txt'), 'utf8')).toBe('http change\n')
})
