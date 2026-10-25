import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNodeAgentHost } from '@keundal/agent-runtime-node'
import type { NativeInvoke } from '@keundal/chat/platform'
import { createNativeRuntimePluginManager } from '@keundal/plugin-chat-desktop'
import { expect, onTestFinished, test, vi } from 'vitest'

import { manageRuntimePlugins, createDesktopComposition, type PluginRequest } from '../sidecar/runtime-plugins'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-managed-'))
  onTestFinished(() => rmSync(directory, { force: true, recursive: true }))
  const module = join(directory, 'plugin.mjs')
  writeFileSync(module, 'export default () => {}')
  return { directory, module }
}

test('로컬 플러그인은 영속화되며 비활성화와 제거가 모듈 데이터를 보존한다', async () => {
  const { directory, module } = fixture()
  await manageRuntimePlugins(directory, {
    action: 'install',
    spec: { module, export: 'default', config: { retained: true } }
  })
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toEqual([
    { module, export: 'default', config: { retained: true }, enabled: false }
  ])
  await manageRuntimePlugins(directory, { action: 'enable', module, enabled: true })
  rmSync(module)
  // A missing or broken module must not prevent turning it off.
  await manageRuntimePlugins(directory, { action: 'enable', module, enabled: false })
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toMatchObject([{ enabled: false }])
  writeFileSync(module, 'user data')
  await manageRuntimePlugins(directory, { action: 'remove', module })
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toEqual([])
  expect(readFileSync(module, 'utf8')).toBe('user data')
})

test('설치 실패는 기존 선택을 변경하지 않고 상대 경로와 명령 인자를 거부한다', async () => {
  const { directory, module } = fixture()
  await manageRuntimePlugins(directory, { action: 'install', spec: { module } })
  const before = readFileSync(join(directory, 'managed.json'), 'utf8')
  for (const invalid of [
    './plugin.mjs',
    '--ignore-scripts=false',
    'name;touch /tmp/injected',
    'https://example.com/plugin.tgz',
    join(directory, 'missing.mjs')
  ]) {
    await expect(manageRuntimePlugins(directory, { action: 'install', spec: { module: invalid } })).rejects.toThrow()
    expect(readFileSync(join(directory, 'managed.json'), 'utf8')).toBe(before)
  }
})

test('재시작 실패는 이전 선택을 복구하고 다음 비활성화를 허용한다', async () => {
  const { directory, module } = fixture()
  const invoke: NativeInvoke = async <T>(_command: string, args?: Record<string, unknown>) =>
    (await manageRuntimePlugins(directory, args!.request as PluginRequest)) as T
  const reload = vi.fn().mockRejectedValueOnce(new Error('broken plugin')).mockResolvedValue(undefined)
  const manager = createNativeRuntimePluginManager(invoke, reload)
  await manager.install({ module })
  expect(reload).not.toHaveBeenCalled()
  await expect(manager.setEnabled(module, true)).rejects.toThrow('broken plugin')
  expect(await manager.list()).toEqual([{ module, enabled: false }])
  await manager.setEnabled(module, false)
  expect(await manager.list()).toEqual([{ module, enabled: false }])
  expect(existsSync(module)).toBe(true)
})

test('배포 매니페스트와 상대 경로 기준 및 필수 서비스를 유지하면서 활성 플러그인을 적용한다', async () => {
  const { directory, module } = fixture()
  const config = join(directory, 'deployment.json')
  const deployment = {
    plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }, { module: './deployment.mjs' }],
    agent: { module: 'builtin:agent' },
    tools: []
  }
  writeFileSync(config, JSON.stringify(deployment))
  writeFileSync(join(directory, 'deployment.mjs'), 'export default () => {}')
  await manageRuntimePlugins(directory, { action: 'install', spec: { module } })
  await manageRuntimePlugins(directory, { action: 'enable', module, enabled: true })
  const options = { provider: 'openai', model: 'test', apiKey: '', sqlitePath: ':memory:', pluginConfigPath: config }
  const host = await createNodeAgentHost(options, createDesktopComposition(directory))
  await host.dispose()
  expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual(deployment)
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toEqual([{ module, enabled: true }])
})

test('손상된 선택이 저장되어 있어도 호스트가 시작되고 진단을 제공하며 비활성화할 수 있다', async () => {
  const { directory, module } = fixture()
  writeFileSync(module, 'export default () => { throw new Error("broken optional plugin") }')
  await manageRuntimePlugins(directory, { action: 'install', spec: { module } })
  await manageRuntimePlugins(directory, { action: 'enable', module, enabled: true })
  const options = { provider: 'openai', model: 'test', apiKey: '', sqlitePath: ':memory:' }
  const host = await createNodeAgentHost(options, createDesktopComposition(directory))
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toEqual([
    { module, enabled: true, error: 'broken optional plugin' }
  ])
  await host.dispose()
  await manageRuntimePlugins(directory, { action: 'enable', module, enabled: false })
  const recovered = await createNodeAgentHost(options, createDesktopComposition(directory))
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toEqual([{ module, enabled: false }])
  await recovered.dispose()
})

test('npm 설치는 별도 디렉터리에서 shell 없이 스크립트 비활성화 인자를 사용한다', async () => {
  const { directory } = fixture()
  const cli = join(directory, 'npm-cli.cjs')
  const log = join(directory, 'npm-args.json')
  writeFileSync(
    cli,
    `
    const fs = require('node:fs'), path = require('node:path');
    fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
    const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
    const pkg = path.join(prefix, 'node_modules', 'example-plugin');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({type:'module', exports:{import:'./index.js'}}));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'export default () => {}');
  `
  )
  vi.stubEnv('KEUNDAL_NPM_CLI', cli)
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  await manageRuntimePlugins(directory, { action: 'install', spec: { module: 'example-plugin@1.0.0' } })
  const args: string[] = JSON.parse(readFileSync(log, 'utf8'))
  expect(args).toContain('--ignore-scripts')
  expect(args.slice(-2)).toEqual(['--', 'example-plugin@1.0.0'])
  const prefix = args[args.indexOf('--prefix') + 1]!
  expect(prefix.startsWith(join(directory, 'packages'))).toBe(true)
  await manageRuntimePlugins(directory, { action: 'remove', module: 'example-plugin@1.0.0' })
  expect(existsSync(join(prefix, 'node_modules/example-plugin/index.js'))).toBe(true)
})

test('다른 선택이 저장되면 오래된 트랜잭션 복구가 새 선택을 덮어쓰지 않는다', async () => {
  const { directory, module } = fixture()
  const transaction = await manageRuntimePlugins(directory, { action: 'install', spec: { module } })
  await manageRuntimePlugins(directory, { action: 'enable', module, enabled: true })
  if (Array.isArray(transaction)) throw new Error('Expected mutation transaction')
  await expect(manageRuntimePlugins(directory, { action: 'restore', ...transaction })).rejects.toThrow(
    'changed before rollback'
  )
})

test('이미 설치한 활성 모듈을 다시 설치하면 기존 설정과 선택을 보존한다', async () => {
  const { directory, module } = fixture()
  await manageRuntimePlugins(directory, { action: 'install', spec: { module, config: { original: true } } })
  await manageRuntimePlugins(directory, { action: 'enable', module, enabled: true })
  const before = readFileSync(join(directory, 'managed.json'), 'utf8')
  await expect(
    manageRuntimePlugins(directory, { action: 'install', spec: { module, config: { original: false } } })
  ).rejects.toThrow('already installed')
  expect(readFileSync(join(directory, 'managed.json'), 'utf8')).toBe(before)
})

test('설치만 한 모듈은 import하지 않고 명시적으로 활성화한 named export의 설정과 정리를 적용한다', async () => {
  const { directory, module } = fixture()
  const marker = join(directory, 'lifecycle.txt')
  writeFileSync(
    module,
    `
    import { appendFileSync } from 'node:fs';
    const marker = ${JSON.stringify(marker)};
    appendFileSync(marker, 'import;');
    export function activate(ctx, config) {
      appendFileSync(marker, config.value + ';');
      ctx.effect(() => () => { appendFileSync(marker, 'dispose;'); });
    }
  `
  )
  await manageRuntimePlugins(directory, {
    action: 'install',
    spec: { module, export: 'activate', config: { value: 'active' } }
  })
  const options = { provider: 'openai', model: 'test', apiKey: '', sqlitePath: ':memory:' }
  const disabled = await createNodeAgentHost(options, createDesktopComposition(directory))
  expect(existsSync(marker)).toBe(false)
  await disabled.dispose()
  await manageRuntimePlugins(directory, { action: 'enable', module, enabled: true })
  const enabled = await createNodeAgentHost(options, createDesktopComposition(directory))
  expect(readFileSync(marker, 'utf8')).toBe('import;active;')
  await enabled.dispose()
  expect(readFileSync(marker, 'utf8')).toBe('import;active;dispose;')
})

test('활성화 진단이 발생하면 관리자는 비활성 설치를 보존하고 이전 런타임 선택을 복구한다', async () => {
  const { directory, module } = fixture()
  writeFileSync(module, 'throw new Error("import failed")')
  const invoke: NativeInvoke = async <T>(_command: string, args?: Record<string, unknown>) =>
    (await manageRuntimePlugins(directory, args!.request as PluginRequest)) as T
  const reload = vi.fn(async () => {
    const host = await createNodeAgentHost(
      { provider: 'openai', model: 'test', apiKey: '', sqlitePath: ':memory:' },
      createDesktopComposition(directory)
    )
    await host.dispose()
  })
  const manager = createNativeRuntimePluginManager(invoke, reload)
  await manager.install({ module })
  await expect(manager.setEnabled(module, true)).rejects.toThrow('import failed')
  expect(await manager.list()).toEqual([{ module, enabled: false }])
  expect(reload).toHaveBeenCalledTimes(2)
  await manager.setEnabled(module, false)
})

test('번들 IPC 명령은 손상된 설치가 있어도 목록과 비활성화를 제공하고 호스트는 정상 시작한다', async () => {
  const { directory, module } = fixture()
  writeFileSync(module, 'export default () => { throw new Error("bundled broken plugin") }')
  const env = { ...process.env, KEUNDAL_MANAGED_PLUGINS: directory }
  const command = async (request: PluginRequest) => {
    const process = spawn(globalThis.process.execPath, ['dist-sidecar/main.js', '--manage-runtime-plugins'], {
      env,
      signal: AbortSignal.timeout(10_000)
    })
    let output = ''
    let errors = ''
    process.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    process.stderr.on('data', (chunk) => {
      errors += String(chunk)
    })
    process.stdin.end(JSON.stringify(request))
    const [status] = await once(process, 'close')
    expect(status, errors).toBe(0)
    return JSON.parse(output)
  }
  await command({ action: 'install', spec: { module } })
  expect(await command({ action: 'list' })).toEqual([{ module, enabled: false }])
  await command({ action: 'enable', module, enabled: true })
  const child = spawn(process.execPath, ['dist-sidecar/main.js'], {
    env: {
      ...env,
      PORT: '0',
      KEUNDAL_PROVIDER: 'openai',
      KEUNDAL_MODEL: 'test',
      KEUNDAL_API_TOKEN: 'plugin-test-token',
      KEUNDAL_SQLITE_PATH: ':memory:'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  await expect.poll(() => output, { timeout: 5_000 }).toContain('keundal server listening')
  const endpoint = /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0]
  const response = await fetch(`${endpoint}/threads`, { headers: { authorization: 'Bearer plugin-test-token' } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual([])
  expect(await command({ action: 'list' })).toEqual([{ module, enabled: true, error: 'bundled broken plugin' }])
  await command({ action: 'enable', module, enabled: false })
  expect(await command({ action: 'list' })).toEqual([{ module, enabled: false }])
})
