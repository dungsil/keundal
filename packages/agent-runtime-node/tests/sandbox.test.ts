import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSandboxedAgentRuntime, readSandboxPolicy } from '@keundal/agent-runtime-node/sandbox'
import type { AGUIEvent } from '@keundal/core'
import { expect, test, vi, type TestContext } from 'vitest'

vi.setConfig({ testTimeout: 240_000, hookTimeout: 130_000 })

async function fixture(t: TestContext, approval: 'allow' | 'ask') {
  const directory = await mkdtemp(join(tmpdir(), 'keundal-host-sandbox-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const outside = join(directory, 'secret.txt')
  await writeFile(outside, 'outside-secret')
  await symlink(outside, join(workspace, 'escape'))
  let deniedHits = 0
  const denied = createServer((_request, response) => {
    deniedHits++
    response.end('must-not-be-reached')
  })
  denied.listen(0, '127.0.0.1')
  await once(denied, 'listening')
  t.onTestFinished(() => {
    denied.closeAllConnections()
    denied.close()
  })
  const deniedAddress = denied.address()
  if (!deniedAddress || typeof deniedAddress === 'string') throw new Error('Missing denied address')
  const deniedEndpoint = `http://127.0.0.1:${deniedAddress.port}`
  const allowed = createServer((request, response) => {
    if (request.url === '/redirect') response.writeHead(302, { location: deniedEndpoint }).end()
    else if (request.url === '/malformed')
      request.socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTrailer: X\r\nConnection: close\r\n\r\n')
    else response.end('allowed-network')
  })
  allowed.listen(0, '127.0.0.1')
  await once(allowed, 'listening')
  t.onTestFinished(() => {
    allowed.closeAllConnections()
    allowed.close()
  })
  const address = allowed.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  const endpoint = `http://127.0.0.1:${address.port}`
  await writeFile(
    join(workspace, 'probe.mjs'),
    `
    import { readFileSync, writeFileSync } from 'node:fs'
    import { execFileSync } from 'node:child_process'
    import { connect } from 'node:net'
    const outside = ${JSON.stringify(outside)}
    function attempt(operation) { try { operation(); return 'escaped' } catch { return 'blocked' } }
    const imported = attempt(() => readFileSync(outside))
    export default () => [{
      name: 'probe', description: 'Probe the OS boundary', parameters: { type: 'object' },
      execute: async () => {
        writeFileSync('inside.txt', 'workspace-write')
        const directNetwork = await new Promise(resolve => {
          const socket = connect({ host: '127.0.0.1', port: ${address.port} })
          socket.once('connect', () => { socket.destroy(); resolve('escaped') })
          socket.once('error', () => resolve('blocked'))
          socket.setTimeout(1000, () => { socket.destroy(); resolve('blocked') })
        })
        return JSON.stringify({
          imported,
          absoluteRead: attempt(() => readFileSync(outside)),
          traversalRead: attempt(() => readFileSync('../secret.txt')),
          symlinkRead: attempt(() => readFileSync('escape')),
          outsideWrite: attempt(() => writeFileSync(outside, 'modified', { flag: 'r+' })),
          shell: execFileSync('/bin/sh', ['-c', '/bin/busybox cat "$1" 2>/dev/null || printf blocked', 'sh', outside], { encoding: 'utf8' }),
          shellInside: execFileSync('/bin/sh', ['-c', '/bin/busybox cat inside.txt'], { encoding: 'utf8' }),
          workspace: readFileSync('inside.txt', 'utf8'),
          inheritedSecret: process.env.SANDBOX_PARENT_SECRET ?? 'absent',
          directNetwork,
          allowedNetwork: await (await fetch(${JSON.stringify(endpoint)})).text(),
          deniedNetwork: (await fetch(${JSON.stringify(deniedEndpoint)})).status,
          redirectDenied: (await fetch(${JSON.stringify(endpoint + '/redirect')})).status,
          malformedNetwork: await fetch(${JSON.stringify(endpoint + '/malformed')}).then(() => 'escaped', () => 'blocked')
        })
      }
    }]
  `
  )
  await writeFile(
    join(workspace, 'llm.mjs'),
    `
    export default ctx => ctx.provide('llm', {
      async getModel() { return { contextWindow: 128000, maxOutputTokens: 4096 } },
      async countTokens() { return 10 },
      async *stream(request) {
        const result = request.input.messages.find(message => message.role === 'tool')
        if (!result) {
          yield { type: 'TOOL_CALL_START', toolCallId: 'probe-call', toolCallName: 'probe' }
          yield { type: 'TOOL_CALL_ARGS', toolCallId: 'probe-call', delta: '{}' }
          yield { type: 'TOOL_CALL_END', toolCallId: 'probe-call' }
        } else {
          yield { type: 'TEXT_MESSAGE_START', messageId: 'answer', role: 'assistant' }
          yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: result.content }
          yield { type: 'TEXT_MESSAGE_END', messageId: 'answer' }
        }
      }
    })
  `
  )
  const manifest = join(workspace, 'keundal.plugins.json')
  await writeFile(
    manifest,
    JSON.stringify({
      plugins: [{ module: './llm.mjs' }, { module: 'builtin:store' }],
      agent: { module: 'builtin:agent', config: { subagents: false } },
      tools: [{ module: './probe.mjs' }]
    })
  )
  const runtime = await createSandboxedAgentRuntime({
    policy: { workspace, allowedHosts: [`127.0.0.1:${address.port}`] },
    env: {
      KEUNDAL_SANDBOX_VM_CONFIG: process.env.KEUNDAL_TEST_VM_CONFIG,
      KEUNDAL_PLUGIN_CONFIG: manifest,
      KEUNDAL_PROVIDER: 'fixture',
      KEUNDAL_MODEL: 'test',
      KEUNDAL_API_TOKEN: 'sandbox-token',
      KEUNDAL_SQLITE_PATH: join(workspace, 'chats.sqlite'),
      KEUNDAL_TOOL_APPROVAL: JSON.stringify({ default: approval }),
      SANDBOX_PARENT_SECRET: 'must-not-be-inherited'
    }
  })
  t.onTestFinished(() => runtime.dispose())
  const server = createServer(runtime.app).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.onTestFinished(() => {
    server.closeAllConnections()
    server.close()
  })
  const bound = server.address()
  if (!bound || typeof bound === 'string') throw new Error('Missing host address')
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${bound.port}${path}`, {
      ...init,
      headers: { authorization: 'Bearer sandbox-token', 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(10_000)
    })
  return { request, outside, workspace, runtime, deniedHits: () => deniedHits }
}

test.for(['allow', 'ask'] as const)(
  '%s 승인 후에도 외부 플러그인과 Shell의 작업공간 이탈을 차단하고 세션과 네트워크 허용 목록을 유지한다',
  async (approval, t) => {
    const { request, outside, workspace, runtime, deniedHits } = await fixture(t, approval)
    expect((await request('/threads', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    const response = await request('/runs', {
      method: 'POST',
      body: JSON.stringify({
        threadId: 'thread',
        runId: 'run',
        state: {},
        tools: [],
        context: [],
        messages: [{ id: 'user', role: 'user', content: 'Probe' }]
      })
    })
    expect(response.status).toBe(200)
    const events: AGUIEvent[] = []
    let buffer = ''
    for await (const chunk of response.body!) {
      buffer += Buffer.from(chunk).toString('utf8')
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame.split('\n').find((line) => line.startsWith('data: '))
        if (!data) continue
        const event = JSON.parse(data.slice(6)) as AGUIEvent
        events.push(event)
        if (event.type === 'CUSTOM' && event.name === 'keundal.tool.approval' && event.value.status === 'requested') {
          const accepted = await request(`/runs/run/approvals/${event.value.requestId}`, {
            method: 'POST',
            body: JSON.stringify({ decision: 'allow' })
          })
          expect(accepted.status).toBe(202)
          await accepted.text()
        }
      }
    }
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
    const text = events
      .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => event.delta)
      .join('')
    expect(JSON.parse(text)).toEqual({
      imported: 'blocked',
      absoluteRead: 'blocked',
      traversalRead: 'blocked',
      symlinkRead: 'blocked',
      outsideWrite: 'blocked',
      shell: 'blocked',
      shellInside: 'workspace-write',
      workspace: 'workspace-write',
      inheritedSecret: 'absent',
      directNetwork: 'blocked',
      allowedNetwork: 'allowed-network',
      deniedNetwork: 403,
      redirectDenied: 403,
      malformedNetwork: 'blocked'
    })
    expect(deniedHits()).toBe(0)
    expect(await readFile(outside, 'utf8')).toBe('outside-secret')
    expect(await (await request('/threads/thread')).json()).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: text })])
    })
    await runtime.dispose()
    expect(await readFile(join(workspace, 'inside.txt'), 'utf8')).toBe('workspace-write')
  }
)

test('격리 설정이 없거나 알 수 없는 권한을 포함하면 호스트를 시작하지 않는다', async (t) => {
  await expect(createSandboxedAgentRuntime({ env: {} })).rejects.toThrow('KEUNDAL_SANDBOX_CONFIG')
  const directory = await mkdtemp(join(tmpdir(), 'keundal-policy-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'policy.json')
  for (const policy of [
    null,
    [],
    { workspace: directory, allowEverything: true },
    { workspace: directory, allowedHosts: ['*'] }
  ]) {
    await writeFile(path, JSON.stringify(policy))
    await expect(createSandboxedAgentRuntime({ env: { KEUNDAL_SANDBOX_CONFIG: path } })).rejects.toThrow()
  }
  await writeFile(path, JSON.stringify({ workspace: directory, allowedHosts: [] }))
  expect(await readSandboxPolicy({ KEUNDAL_SANDBOX_CONFIG: path })).toEqual({ workspace: directory, allowedHosts: [] })
})

test('초기화에 실패하면 비격리 호스트로 재시도하지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'keundal-failed-sandbox-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  await expect(
    createSandboxedAgentRuntime({
      policy: { workspace: directory },
      env: { KEUNDAL_SANDBOX_VM_CONFIG: process.env.KEUNDAL_TEST_VM_CONFIG },
      workerSource: "throw new Error('worker initialization failed')"
    })
  ).rejects.toThrow('exited before becoming ready')
})

test('자식의 잘못된 응답 헤더는 해당 연결만 끊고 다음 호스트 요청을 유지한다', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'keundal-host-headers-'))
  t.onTestFinished(() => rm(workspace, { recursive: true, force: true }))
  const runtime = await createSandboxedAgentRuntime({
    policy: { workspace },
    env: { KEUNDAL_SANDBOX_VM_CONFIG: process.env.KEUNDAL_TEST_VM_CONFIG },
    workerSource: `
      import { connect } from 'node:net'
      function open() {
        const socket = connect('/run/keundal/api.sock')
        socket.on('error', () => socket.destroy())
        socket.once('data', chunk => {
          open()
          socket.end(chunk.toString().startsWith('GET /bad ')
            ? 'HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nTrailer: X\\r\\nConnection: close\\r\\n\\r\\n'
            : 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok')
        })
      }
      open(); open()
      console.log('keundal-sandbox-ready')
    `
  })
  t.onTestFinished(() => runtime.dispose())
  const server = createServer(runtime.app).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.onTestFinished(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing host address')
  const url = `http://127.0.0.1:${address.port}`
  await expect(fetch(`${url}/bad`, { signal: AbortSignal.timeout(5000) })).rejects.toThrow()
  expect(await (await fetch(`${url}/healthy`, { signal: AbortSignal.timeout(5000) })).text()).toBe('ok')
})
