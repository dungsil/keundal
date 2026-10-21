import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, onTestFinished, test } from 'vitest'

const token = 'test-only-sidecar-token'

test('실행 파일은 토큰 누락·빈 토큰·빈 바인딩 주소에서 시작하지 않는다', () => {
  for (const config of [
    {},
    { KEUNDAL_API_TOKEN: '' },
    { KEUNDAL_API_TOKEN: ' ' },
    { KEUNDAL_API_TOKEN: token, KEUNDAL_HOST: '' }
  ]) {
    const result = spawnSync(process.execPath, ['dist-sidecar/main.js'], {
      env: { PORT: '0', KEUNDAL_MODEL: 'test', OPENAI_API_KEY: 'test-only', ...config },
      encoding: 'utf8',
      timeout: 5000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/HTTP 인증 token|KEUNDAL_HOST/)
    expect(result.stdout).not.toContain('listening')
  }
})

test.each([undefined, '0.0.0.0'])('실행 파일은 기본 loopback과 명시적 외부 바인딩(%s)을 적용한다', async (host) => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-sidecar-'))
  const child = spawn(process.execPath, ['dist-sidecar/main.js'], {
    env: {
      PORT: '0',
      KEUNDAL_MODEL: 'test',
      OPENAI_API_KEY: 'test-only',
      KEUNDAL_API_TOKEN: token,
      KEUNDAL_SQLITE_PATH: join(directory, 'test.sqlite'),
      ...(host === undefined ? {} : { KEUNDAL_HOST: host })
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    rmSync(directory, { recursive: true, force: true })
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  await expect.poll(() => output, { timeout: 5000 }).toContain(`http://${host ?? '127.0.0.1'}:`)
  const port = /http:\/\/[^:]+:(\d+)/.exec(output)?.[1]
  expect(port).toBeDefined()
  const response = await fetch(`http://127.0.0.1:${port}/threads`, { headers: { authorization: `Bearer ${token}` } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual([])
  const denied = await fetch(`http://127.0.0.1:${port}/threads`)
  expect(denied.status).toBe(401)
  await denied.text()

  const external = Object.values(networkInterfaces())
    .flat()
    .find(address => address?.family === 'IPv4' && !address.internal)
  if (external) {
    const request = fetch(`http://${external.address}:${port}/threads`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000)
    })
    if (host === undefined) {
      await expect(request).rejects.toThrow()
    } else {
      const exposed = await request
      expect(exposed.status).toBe(200)
      expect(await exposed.json()).toEqual([])
    }
  }
})

test('명시한 공급자는 키 없는 사용자 지정 API를 사용하고 같은 SQLite를 새 공급자에서도 보존한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-sidecar-switch-'))
  const path = join(directory, 'test.sqlite')
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const start = async (provider: string, model: string) => {
    const child = spawn(process.execPath, ['dist-sidecar/main.js'], {
      env: {
        PORT: '0',
        KEUNDAL_SIDECAR: '1',
        KEUNDAL_PROVIDER: provider,
        KEUNDAL_MODEL: model,
        KEUNDAL_API_TOKEN: token,
        KEUNDAL_SQLITE_PATH: path,
        KEUNDAL_BASE_URL: 'http://127.0.0.1:1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
    }
    onTestFinished(stop)
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    await expect.poll(() => output, { timeout: 5000 }).toContain('"kind":"keundal-sidecar"')
    const endpoint = /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0]
    const headers = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }
    return { stop, call: (route: string, init?: RequestInit) => fetch(`${endpoint}${route}`, { ...init, headers }) }
  }
  const first = await start('openai', 'first')
  const created = await first.call('/threads/saved', {
    method: 'PUT',
    body: JSON.stringify({
      expectedRevision: 0,
      messages: [{ id: 'user', role: 'user', content: '보존할 대화' }],
      state: { retained: true }
    })
  })
  expect(created.ok).toBe(true)
  await created.text()
  await first.stop()
  const second = await start('anthropic', 'second')
  expect(await (await second.call('/models')).json()).toEqual({
    models: [{ id: 'second', provider: 'anthropic', contextWindow: 128000, maxOutputTokens: 4096 }]
  })
  expect(await (await second.call('/threads/saved')).json()).toMatchObject({
    messages: [{ id: 'user', role: 'user', content: '보존할 대화' }],
    state: { retained: true }
  })
  await second.stop()
})

test('종료 제어 파이프가 닫히면 sidecar가 정상 종료한다', async () => {
  const child = spawn(process.execPath, ['dist-sidecar/main.js'], {
    env: {
      PORT: '0', KEUNDAL_SIDECAR: '1', KEUNDAL_SHUTDOWN_ON_STDIN: '1',
      KEUNDAL_PROVIDER: 'openai', KEUNDAL_MODEL: 'test', KEUNDAL_API_TOKEN: token,
      KEUNDAL_SQLITE_PATH: ':memory:',
      KEUNDAL_MCP_SERVERS: JSON.stringify([{ serverName: 'offline', transport: 'streamable-http', url: 'http://127.0.0.1:1', permissions: { tools: '*' } }])
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  onTestFinished(() => {
    if (child.exitCode === null) child.kill()
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  await expect.poll(() => output, { timeout: 5000 }).toContain('keundal-sidecar')
  const exited = once(child, 'exit')
  child.stdin.end()
  expect(await exited).toEqual([0, null])
})
