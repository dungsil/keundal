import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createNodeAgentHost } from '@keundal/agent-runtime-node'
import type { NativeInvoke } from '@keundal/chat/platform'
import { createNativeRuntimePluginManager } from '@keundal/plugin-chat-desktop'
import { createChartTools, metadata as chartMetadata } from '@keundal/plugin-tool-chart'
import { createTodoTools } from '@keundal/plugin-tool-todo'
import { createWeatherTools, metadata as weatherMetadata } from '@keundal/plugin-tool-weather'
import { strToU8, zipSync } from 'fflate'
import { expect, onTestFinished, test, vi } from 'vitest'

import { manageRuntimePlugins, createDesktopComposition, type PluginRequest } from '../sidecar/runtime-plugins'

const chart = '@keundal/plugin-tool-chart'
const weather = '@keundal/plugin-tool-weather'
const skills = '@keundal/plugin-skill'
const mcp = '@keundal/plugin-mcp-client'
const prompt = '@keundal/prompt'
const subagent = '@keundal/subagent'
const agent = '@keundal/plugin-agent-chat'
const addedDefaults = [prompt, subagent, agent, '@keundal/plugin-tool-todo'].map(module => ({ module, enabled: true }))

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-bundled-'))
  onTestFinished(() => rmSync(directory, { force: true, recursive: true }))
  const options = { provider: 'openai', model: 'test', apiKey: '', sqlitePath: join(directory, 'chats.sqlite'), defaultTools: [...createChartTools(), ...createWeatherTools()] }
  const compose = createDesktopComposition(directory)
  const open = async (provider = 'openai') => {
    const host = await createNodeAgentHost({ ...options, provider }, compose)
    onTestFinished(() => host.dispose())
    return host
  }
  const invoke: NativeInvoke = async <T>(_command: string, args?: Record<string, unknown>) =>
    (await manageRuntimePlugins(directory, args!.request as PluginRequest)) as T
  return { directory, options, compose, open, invoke }
}

test('기존 선택에 TODO를 기본 활성으로 추가하고 독립 선택을 재시작 뒤에도 유지한다', async () => {
  const { directory, options, compose } = fixture()
  const path = join(directory, 'bundled-selection.json')
  writeFileSync(path, JSON.stringify([
    { module: skills, enabled: true }, { module: mcp, enabled: false },
    { module: chart, enabled: false }, { module: weather, enabled: false },
    { module: prompt, enabled: false }, { module: subagent, enabled: false }, { module: agent, enabled: true }
  ]))
  for (const selection of [undefined, false, true]) {
    const enabled = selection ?? true
    if (selection !== undefined)
      await manageRuntimePlugins(directory, { action: 'enable', module: '@keundal/plugin-tool-todo', enabled })
    const host = await createNodeAgentHost({ ...options, defaultTools: createTodoTools() }, compose)
    onTestFinished(() => host.dispose())
    expect((await host.services.catalog!()).tools.map(tool => tool.name)).toEqual(enabled ? ['todo_write'] : [])
    expect(await manageRuntimePlugins(directory, { action: 'list' })).toContainEqual(expect.objectContaining({ module: '@keundal/plugin-tool-todo', enabled }))
    await host.dispose()
  }
})

test('번들 목록은 LLM과 저장소만 잠그고 에이전트와 의존 관계를 노출한다', async () => {
  const { directory, open } = fixture()
  const host = await open()
  const entries = await manageRuntimePlugins(directory, { action: 'list' })
  expect(entries).toMatchObject([
    { module: '@keundal/plugin-llm-openai', enabled: true, required: true },
    { module: '@keundal/plugin-store-sqlite', enabled: true, required: true },
    { module: skills, enabled: true, feature: 'skills' }, { module: mcp, enabled: true, feature: 'mcp' },
    { module: chart, enabled: true }, { module: weather, enabled: true },
    { module: prompt, enabled: true, requires: [agent] },
    { module: subagent, enabled: true, requires: [agent] },
    { module: agent, enabled: true, requires: ['@keundal/plugin-llm-openai', '@keundal/plugin-store-sqlite'] },
    { module: '@keundal/plugin-tool-todo', enabled: true }
  ])
  if (!Array.isArray(entries)) throw new Error('Expected plugin list')
  expect(entries.find(entry => entry.module === chart)?.metadata).toEqual(chartMetadata)
  expect(entries.find(entry => entry.module === weather)?.metadata).toEqual(weatherMetadata)
  expect(entries.find(entry => entry.module === agent)?.required).toBeUndefined()
  expect(entries.find(entry => entry.module === skills)?.metadata).toEqual({
    name: { en: 'Skills', ko: '스킬' },
    description: {
      en: 'Provides reusable instructions for the agent to load when needed.',
      ko: '에이전트가 필요할 때 불러올 수 있는 재사용 가능한 지침을 제공합니다.'
    }
  })
  for (const entry of entries) {
    for (const locale of ['en', 'ko'] as const) {
      expect(entry.metadata?.name[locale]).toBeTruthy()
      expect(entry.metadata?.description[locale]).toBeTruthy()
    }
  }
  expect((await host.services.catalog!()).tools.map(({ name }) => name)).toEqual(['chart', 'weather'])
  await host.dispose()
  const switched = await open('gemini')
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toContainEqual(expect.objectContaining({
    module: '@keundal/plugin-llm-gemini', enabled: true, required: true,
    metadata: expect.objectContaining({ name: { en: 'Gemini', ko: 'Gemini' } })
  }))
  expect(switched.services.models()).toMatchObject([{ id: 'test', provider: 'gemini' }])
})

test('선택을 별도 파일에 보존하고 실제 도구 목록을 바꾸면서 SQLite 대화를 유지한다', async () => {
  const { directory, open } = fixture()
  const before = await open()
  await before.services.session.commit({ threadId: 'saved', expectedRevision: 0, state: {}, messages: [{ id: 'user', role: 'user', content: 'keep me' }] })
  await before.dispose()
  for (const [module, enabled, names] of [
    [chart, false, ['weather']],
    [weather, false, []],
    [chart, true, ['chart']],
    [weather, true, ['chart', 'weather']]
  ] as const) {
    await manageRuntimePlugins(directory, { action: 'enable', module, enabled })
    expect(JSON.parse(readFileSync(join(directory, 'bundled-selection.json'), 'utf8'))).toContainEqual({ module, enabled })
    const reopened = await open()
    expect((await reopened.services.catalog!()).tools.map(({ name }) => name)).toEqual(names)
    expect((await reopened.services.session.get('saved'))?.messages).toEqual([{ id: 'user', role: 'user', content: 'keep me' }])
    await reopened.dispose()
  }
  const enabled = await open()
  expect((await enabled.services.catalog!()).tools.map(({ name }) => name)).toEqual(['chart', 'weather'])
  expect((await enabled.services.session.get('saved'))?.revision).toBe(1)
})

test('이전 외부 설치는 import하지 않고 알려진 boolean만 안전하게 옮긴다', async () => {
  const { directory, open } = fixture()
  const external = join(directory, 'external.mjs')
  const marker = join(directory, 'imported')
  writeFileSync(external, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); throw new Error('external import')`)
  const legacy = [
    { module: external, resolvedModule: external, enabled: true },
    { module: '@keundal/plugin-tool-chat', resolvedModule: external, enabled: false, config: { arbitrary: true }, export: 'activate' },
    { module: skills, enabled: 'false' }
  ]
  writeFileSync(join(directory, 'managed.json'), JSON.stringify(legacy))
  const host = await open()
  expect(await host.services.catalog!()).toEqual({ skills: [], tools: [] })
  expect(existsSync(marker)).toBe(false)
  expect(await manageRuntimePlugins(directory, { action: 'list' })).not.toContainEqual(expect.objectContaining({ module: external }))
  await manageRuntimePlugins(directory, { action: 'enable', module: mcp, enabled: false })
  expect(JSON.parse(readFileSync(join(directory, 'managed.json'), 'utf8'))).toEqual(legacy)
  expect(readFileSync(join(directory, 'bundled-selection.json'), 'utf8')).not.toContain('resolvedModule')
  expect(existsSync(external)).toBe(true)
})

test.each([true, false])('이전 bundled-selection.json의 결합 선택 $0을 분리하고 독립 변경을 저장한다', async (enabled) => {
  const { directory, open } = fixture()
  const legacy = [
    { module: skills, enabled: true },
    { module: mcp, enabled: true },
    { module: '@keundal/plugin-tool-chat', enabled }
  ]
  const path = join(directory, 'bundled-selection.json')
  writeFileSync(path, JSON.stringify(legacy))
  const host = await open()
  expect((await host.services.catalog!()).tools.map(({ name }) => name)).toEqual(enabled ? ['chart', 'weather'] : [])
  await host.dispose()
  const transaction = await manageRuntimePlugins(directory, { action: 'enable', module: chart, enabled: !enabled })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
    { module: skills, enabled: true }, { module: mcp, enabled: true },
    { module: chart, enabled: !enabled }, { module: weather, enabled }, ...addedDefaults
  ])
  const reopened = await open()
  expect((await reopened.services.catalog!()).tools.map(({ name }) => name)).toEqual(enabled ? ['weather'] : ['chart'])
  if (Array.isArray(transaction)) throw new Error('Expected transaction')
  await manageRuntimePlugins(directory, { action: 'restore', previous: legacy, expected: transaction.expected } as PluginRequest)
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toEqual(expect.arrayContaining([
    expect.objectContaining({ module: chart, enabled }), expect.objectContaining({ module: weather, enabled })
  ]))
})

test('이전 결합 선택을 분리할 때 설치한 외부 플러그인의 활성 상태와 파일을 보존한다', async () => {
  const { directory, open } = fixture()
  const source = join(directory, 'plugin.mjs')
  writeFileSync(source, 'export default ctx => { ctx.provide("retainedExternal", true) }')
  const installed = await manageRuntimePlugins(directory, { action: 'install', source: { type: 'path', value: source } })
  if (Array.isArray(installed)) throw new Error('Expected transaction')
  const external = { ...installed.expected.at(-1)!, enabled: true }
  const legacy = [
    { module: skills, enabled: true }, { module: mcp, enabled: true },
    { module: '@keundal/plugin-tool-chat', enabled: false }, external
  ]
  const path = join(directory, 'bundled-selection.json')
  writeFileSync(path, JSON.stringify(legacy))
  await manageRuntimePlugins(directory, { action: 'enable', module: chart, enabled: true })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
    { module: skills, enabled: true }, { module: mcp, enabled: true },
    { module: chart, enabled: true }, { module: weather, enabled: false }, ...addedDefaults, external
  ])
  const host = await open()
  expect(host.ctx.get('retainedExternal')).toBe(true)
  expect((await host.services.catalog!()).tools.map(({ name }) => name)).toEqual(['chart'])
  expect(existsSync(source)).toBe(true)
})

test('이전 선택 파일도 중복 모듈과 boolean 이외의 값 및 외부 설정을 거부한다', async () => {
  const { directory } = fixture()
  const legacy = [
    { module: skills, enabled: true }, { module: mcp, enabled: true },
    { module: '@keundal/plugin-tool-chat', enabled: false }
  ]
  const path = join(directory, 'bundled-selection.json')
  for (const entries of [
    legacy.slice(1),
    [legacy[0], legacy[0], legacy[2]],
    [...legacy.slice(0, 2), { ...legacy[2], enabled: 'false' }],
    [...legacy.slice(0, 2), { ...legacy[2], config: {} }],
    [...legacy, { module: chart, enabled: true }]
  ]) {
    const contents = JSON.stringify(entries)
    writeFileSync(path, contents)
    await expect(manageRuntimePlugins(directory, { action: 'list' })).rejects.toThrow('Invalid')
    expect(readFileSync(path, 'utf8')).toBe(contents)
  }
})

test('managed.json의 분리된 boolean은 이전 결합 선택보다 우선한다', async () => {
  const { directory, open } = fixture()
  const legacy = [
    { module: '@keundal/plugin-tool-chat', enabled: false },
    { module: chart, enabled: true }, { module: weather, enabled: 'true' }
  ]
  writeFileSync(join(directory, 'managed.json'), JSON.stringify(legacy))
  const host = await open()
  expect((await host.services.catalog!()).tools.map(({ name }) => name)).toEqual(['chart'])
  await manageRuntimePlugins(directory, { action: 'enable', module: weather, enabled: true })
  expect(JSON.parse(readFileSync(join(directory, 'managed.json'), 'utf8'))).toEqual(legacy)
})

test('알 수 없는 모듈과 필수 서비스 및 외부 설치 작업은 선택을 변경하지 않는다', async () => {
  const { directory } = fixture()
  await manageRuntimePlugins(directory, { action: 'enable', module: chart, enabled: false })
  const path = join(directory, 'bundled-selection.json')
  const before = readFileSync(path, 'utf8')
  const invalid: unknown[] = [
    null, {}, { action: 'install', spec: { module: 'example-plugin' } }, { action: 'remove', module: chart },
    ...['example-plugin', 'https://example.com/plugin.mjs', '/tmp/plugin.mjs', './plugin.mjs', '@keundal/plugin-store-sqlite', '@keundal/plugin-llm-openai'].map((module) => ({ action: 'enable', module, enabled: false })),
    { action: 'enable', module: chart, enabled: 'false' },
    { action: 'enable', module: chart, enabled: true, config: {} },
    { action: 'list', spec: { module: '/tmp/plugin.mjs' } }
  ]
  for (const request of invalid) {
    await expect(manageRuntimePlugins(directory, request as PluginRequest)).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
  }
})

test('복구 요청도 알려진 모듈과 boolean만 허용하고 오래된 선택을 덮어쓰지 않는다', async () => {
  const { directory } = fixture()
  const transaction = await manageRuntimePlugins(directory, { action: 'enable', module: chart, enabled: false })
  if (Array.isArray(transaction)) throw new Error('Expected transaction')
  for (const previous of [
    [],
    transaction.previous.map((entry, index) => index ? entry : { ...entry, module: '/tmp/external.mjs' }),
    transaction.previous.map((entry) => ({ ...entry, config: {} })),
    transaction.previous.map((entry) => ({ ...entry, enabled: 'true' }))
  ]) {
    await expect(manageRuntimePlugins(directory, { action: 'restore', ...transaction, previous } as PluginRequest)).rejects.toThrow('Invalid bundled selection')
  }
  await manageRuntimePlugins(directory, { action: 'enable', module: skills, enabled: false })
  await expect(manageRuntimePlugins(directory, { action: 'restore', ...transaction })).rejects.toThrow('changed before rollback')
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toContainEqual(expect.objectContaining({ module: skills, enabled: false, feature: 'skills' }))
})

test('재시작 실패는 이전 선택을 복구하고 다음 작업을 허용한다', async () => {
  const { directory, invoke } = fixture()
  const reload = vi.fn().mockRejectedValueOnce(new Error('restart failed')).mockResolvedValue(undefined)
  const manager = createNativeRuntimePluginManager(invoke, reload)
  expect(Object.keys(manager).sort()).toEqual(['install', 'list', 'remove', 'setEnabled'])
  await expect(manager.setEnabled(chart, false)).rejects.toThrow('restart failed')
  expect(await manager.list()).toContainEqual(expect.objectContaining({ module: chart, enabled: true }))
  await manager.setEnabled(chart, false)
  expect(await manager.list()).toContainEqual(expect.objectContaining({ module: chart, enabled: false }))
  expect(reload).toHaveBeenCalledTimes(2)
  expect(existsSync(join(directory, 'bundled-selection.json'))).toBe(true)
})

test('활성화 진단 실패는 선택과 이미 교체한 호스트를 함께 복구한다', async () => {
  const { invoke } = fixture()
  const diagnosticInvoke: NativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    const result = await invoke<T>(command, args)
    return (Array.isArray(result) ? result.map((entry) => entry.module === weather && entry.enabled ? { ...entry, error: 'activation failed' } : entry) : result) as T
  }
  const reload = vi.fn().mockResolvedValue(undefined)
  const manager = createNativeRuntimePluginManager(diagnosticInvoke, reload)
  await manager.setEnabled(weather, false)
  await expect(manager.setEnabled(weather, true)).rejects.toThrow('activation failed')
  expect(await manager.list()).toContainEqual(expect.objectContaining({ module: weather, enabled: false }))
  expect(reload).toHaveBeenCalledTimes(3)
})

test('재시작과 복구가 모두 실패하면 두 원인을 숨기지 않는다', async () => {
  const { invoke } = fixture()
  const brokenInvoke: NativeInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
    if ((args?.request as PluginRequest)?.action === 'restore') throw new Error('restore failed')
    return invoke<T>(command, args)
  }
  const manager = createNativeRuntimePluginManager(brokenInvoke, async () => { throw new Error('restart failed') })
  await expect(manager.setEnabled(chart, false)).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: 'restart failed' }), expect.objectContaining({ message: 'restore failed' })]
  })
})

test('배포 매니페스트와 상대 경로 및 필수 서비스를 선택 변경 이후에도 유지한다', async () => {
  const { directory, options, compose } = fixture()
  const path = join(directory, 'deployment.json')
  const deployment = {
    plugins: [{ module: 'builtin:llm', config: { provider: 'gemini' } }, { module: 'builtin:store' }, { module: './deployment.mjs' }],
    agent: { module: 'builtin:agent', config: { maxToolRounds: 2 } }, tools: []
  }
  writeFileSync(path, JSON.stringify(deployment))
  writeFileSync(join(directory, 'deployment.mjs'), 'export default ctx => { ctx.provide("deploymentMarker", true) }')
  await manageRuntimePlugins(directory, { action: 'enable', module: skills, enabled: false })
  const host = await createNodeAgentHost({ ...options, pluginConfigPath: path }, compose)
  onTestFinished(() => host.dispose())
  expect(await host.services.catalog!()).toEqual({ skills: [], tools: [] })
  expect(host.ctx.get('deploymentMarker')).toBe(true)
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toContainEqual(expect.objectContaining({ module: '@keundal/plugin-llm-gemini', enabled: true, required: true }))
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(deployment)
})

test('매니페스트의 추가 모듈을 필수로 잠그지 않고 독립적으로 관리한다', async () => {
  const { directory, options, compose } = fixture()
  const path = join(directory, 'deployment.json')
  const deployment = {
    plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }, { module: './optional.mjs' }],
    agent: { module: 'builtin:agent' }
  }
  writeFileSync(path, JSON.stringify(deployment))
  writeFileSync(join(directory, 'optional.mjs'), 'export default ctx => { ctx.provide("optionalMarker", true) }')
  const open = async () => {
    const host = await createNodeAgentHost({ ...options, pluginConfigPath: path }, compose)
    onTestFinished(() => host.dispose())
    return host
  }
  const initial = await open()
  expect(initial.ctx.get('optionalMarker')).toBe(true)
  const listed = await manageRuntimePlugins(directory, { action: 'list' })
  if (!Array.isArray(listed)) throw new Error('Expected list')
  expect(listed.find(entry => entry.module === './optional.mjs')?.required).toBeUndefined()
  await initial.dispose()
  await manageRuntimePlugins(directory, { action: 'enable', module: './optional.mjs', enabled: false })
  const disabled = await open()
  expect(disabled.ctx.get('optionalMarker')).toBeUndefined()
  await disabled.dispose()
  await manageRuntimePlugins(directory, { action: 'enable', module: './optional.mjs', enabled: true })
  expect((await open()).ctx.get('optionalMarker')).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(deployment)
})

test('에이전트 선택을 꺼도 세션과 관리 작업을 유지하고 다시 켤 수 있다', async () => {
  const { directory, open } = fixture()
  const original = await open()
  await original.services.session.commit({ threadId: 'retained', expectedRevision: 0, state: {}, messages: [{ id: 'user', role: 'user', content: 'keep' }] })
  await original.dispose()
  // Migrate the old required-service cache as well as the selection file.
  writeFileSync(join(directory, 'required-modules.json'), JSON.stringify(['@keundal/plugin-llm-openai', '@keundal/plugin-store-sqlite', agent]))
  await manageRuntimePlugins(directory, { action: 'enable', module: agent, enabled: false })
  const disabled = await open()
  await expect((async () => {
    for await (const _event of disabled.services.run({ threadId: 'new', runId: 'disabled', state: {}, messages: [], tools: [], context: [] })) { /* drain */ }
  })()).rejects.toThrow('Agent is disabled')
  expect((await disabled.services.session.get('retained'))?.messages).toEqual([{ id: 'user', role: 'user', content: 'keep' }])
  expect((await disabled.services.catalog!()).tools.map(tool => tool.name)).toEqual(['chart', 'weather'])
  expect(await manageRuntimePlugins(directory, { action: 'list' })).toContainEqual(expect.objectContaining({ module: agent, enabled: false }))
  await manageRuntimePlugins(directory, { action: 'enable', module: prompt, enabled: false })
  await disabled.dispose()
  await manageRuntimePlugins(directory, { action: 'enable', module: agent, enabled: true })
  expect((await (await open()).services.session.get('retained'))?.revision).toBe(1)
})

test('이전 네 선택과 외부 설치를 유지하며 새 선택을 기본 활성화한다', async () => {
  const { directory, open } = fixture()
  const source = join(directory, 'retained.mjs')
  writeFileSync(source, 'export default ctx => { ctx.provide("migratedExternal", true) }')
  const installed = await manageRuntimePlugins(directory, { action: 'install', source: { type: 'path', value: source } })
  if (Array.isArray(installed)) throw new Error('Expected transaction')
  const external = { ...installed.expected.at(-1)!, enabled: true }
  const old = [
    { module: skills, enabled: false }, { module: mcp, enabled: true },
    { module: chart, enabled: false }, { module: weather, enabled: true }, external
  ]
  const path = join(directory, 'bundled-selection.json')
  writeFileSync(path, JSON.stringify(old))
  const host = await open()
  expect(host.ctx.get('migratedExternal')).toBe(true)
  expect((await host.services.catalog!()).tools.map(tool => tool.name)).toEqual(['weather'])
  await manageRuntimePlugins(directory, { action: 'enable', module: prompt, enabled: false })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
    ...old.slice(0, 4), { module: prompt, enabled: false }, { module: subagent, enabled: true }, { module: agent, enabled: true },
    { module: '@keundal/plugin-tool-todo', enabled: true }, external
  ])
  const malformed = [...old.slice(0, 4), { ...external, config: {} }]
  writeFileSync(path, JSON.stringify(malformed))
  await expect(manageRuntimePlugins(directory, { action: 'list' })).rejects.toThrow('Invalid external selection')
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(malformed)
})

test('저장소 밖으로 옮긴 번들 IPC는 시스템 npm 없이 ZIP을 설치하고 선택 기능도 영속화한다', async () => {
  const { directory } = fixture()
  const bundle = join(directory, 'sidecar')
  cpSync('dist-sidecar', bundle, { recursive: true })
  const command = async (request: unknown) => {
    const child = spawn(process.execPath, [join(bundle, 'main.js'), '--manage-runtime-plugins'], {
      cwd: directory,
      env: { ...process.env, PATH: '', KEUNDAL_MANAGED_PLUGINS: directory, KEUNDAL_PROVIDER: 'openai' }, signal: AbortSignal.timeout(10_000)
    })
    let output = ''
    let errors = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { errors += String(chunk) })
    child.stdin.end(JSON.stringify(request))
    const [status] = await once(child, 'close')
    return { status, output, errors }
  }
  expect((await command({ action: 'install', spec: { module: '/tmp/external.mjs' } })).status).toBe(1)
  const disabled = await command({ action: 'enable', module: chart, enabled: false })
  expect(disabled.status, disabled.errors).toBe(0)
  const listed = await command({ action: 'list' })
  expect(listed.status, listed.errors).toBe(0)
  expect(JSON.parse(listed.output)).toContainEqual(expect.objectContaining({ module: chart, enabled: false }))
  expect(JSON.parse(listed.output)).toContainEqual(expect.objectContaining({ module: weather, enabled: true }))
  expect(JSON.parse(listed.output)).toContainEqual(expect.objectContaining({ module: '@keundal/plugin-store-sqlite', enabled: true, required: true }))
  const zip = join(directory, 'plugin.zip')
  writeFileSync(zip, zipSync({
    'package/package.json': strToU8(JSON.stringify({ name: 'portable-plugin', version: '1.0.0', type: 'module', exports: './index.js' })),
    'package/index.js': strToU8('export default ctx => { ctx.provide("portable", true) }')
  }))
  const installed = await command({ action: 'install', source: { type: 'zip', value: zip } })
  expect(installed.status, installed.errors).toBe(0)
  expect(JSON.parse((await command({ action: 'list' })).output)).toContainEqual(expect.objectContaining({
    enabled: false, source: { type: 'zip', value: zip }, version: '1.0.0'
  }))
  const dsh = dshPackage(directory, '- insert:\n  - { name: dsh-fixture/main }', { main: 'export function apply() {}' })
  const dshInstalled = await command({ action: 'install', source: { type: 'zip', value: dsh.zip } })
  expect(dshInstalled.status, dshInstalled.errors).toBe(0)
  expect(JSON.parse(dshInstalled.output).expected.at(-1)).toMatchObject({ enabled: false, format: 'dsh' })
}, 20_000)

test('로컬 패키지와 ZIP은 설치 스크립트와 import 없이 등록하고 활성화할 때 ESM 진입점을 실행한다', async () => {
  const { directory, open, invoke } = fixture()
  const source = join(directory, 'source')
  const marker = join(directory, 'imported')
  const scriptMarker = join(directory, 'script-ran')
  mkdirSync(source)
  const script = `node -e "require('fs').writeFileSync('${scriptMarker.replaceAll('\\', '/')}', 'bad')"`
  const manifest = { name: 'local-plugin', version: '1.2.3', type: 'module', exports: { import: './plugin.mjs', require: './wrong.cjs' },
    scripts: { preinstall: script, prepare: script, postinstall: script } }
  const code = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes'); export default ctx => { ctx.provide('externalMarker', 'loaded') }`
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(source, 'plugin.mjs'), code)
  const zip = join(directory, 'source.zip')
  writeFileSync(zip, zipSync({ 'package.json': strToU8(JSON.stringify(manifest)), 'plugin.mjs': strToU8(code) }))
  const prefix = join(directory, 'outside-prefix')
  vi.stubEnv('npm_config_prefix', prefix)
  vi.stubEnv('npm_config_global', 'true')
  onTestFinished(() => { vi.unstubAllEnvs() })
  for (const input of [{ type: 'path', value: source }, { type: 'zip', value: zip }] as const) {
    const manager = createNativeRuntimePluginManager(invoke, async () => {})
    await manager.install!(input)
    const entry = (await manager.list()).find(entry => entry.source?.type === input.type)!
    expect(entry).toMatchObject({ enabled: false, version: '1.2.3' })
    expect(existsSync(scriptMarker)).toBe(false)
    expect(existsSync(prefix)).toBe(false)
    expect(existsSync(marker)).toBe(false)
    const disabled = await open()
    expect(disabled.ctx.get('externalMarker')).toBeUndefined()
    await disabled.dispose()
    await manager.setEnabled(entry.module, true)
    const host = await open()
    expect(host.ctx.get('externalMarker')).toBe('loaded')
    expect(readFileSync(marker, 'utf8')).toBe('yes')
    await host.dispose()
    const managed = join(directory, 'installed', entry.module.slice('external:'.length))
    await manager.remove!(entry.module)
    expect(await manager.list()).not.toContainEqual(expect.objectContaining({ module: entry.module }))
    expect(existsSync(managed)).toBe(false)
    expect(existsSync(source)).toBe(true)
    rmSync(marker)
  }
}, 20_000)

test('로컬 파일의 활성화 오류는 앱 시작을 막지 않고 재시작 후 선택과 부분 효과를 복구한다', async () => {
  const { directory, open, invoke } = fixture()
  const path = join(directory, 'broken.mjs')
  writeFileSync(path, `export default ctx => { ctx.effect(() => { ctx.provide('partialMarker', true); return () => ctx.provide('partialMarker', false) }); throw new Error('broken plugin') }`)
  let host = await open()
  const manager = createNativeRuntimePluginManager(invoke, async () => {
    await host.dispose()
    host = await open()
  })
  await manager.install!({ type: 'path', value: path })
  const entry = (await manager.list()).find(entry => entry.source)!
  await expect(manager.setEnabled(entry.module, true)).rejects.toThrow('broken plugin')
  expect((await manager.list()).find(item => item.module === entry.module)).toMatchObject({ enabled: false })
  expect(host.ctx.get('partialMarker')).toBeUndefined()
  await manager.setEnabled(entry.module, false)
  await manager.remove!(entry.module)
  expect(existsSync(path)).toBe(true)
})

test('설치 및 삭제 후 재시작이 실패하면 선택과 복구에 필요한 파일을 보존한다', async () => {
  const { directory, invoke } = fixture()
  const path = join(directory, 'plugin.mjs')
  writeFileSync(path, 'export default () => {}')
  const reload = vi.fn().mockRejectedValueOnce(new Error('restart failed')).mockResolvedValue(undefined)
  const manager = createNativeRuntimePluginManager(invoke, reload)
  await expect(manager.install!({ type: 'path', value: path })).rejects.toThrow('restart failed')
  expect((await manager.list()).some(entry => entry.source)).toBe(false)
  expect(readdirSync(join(directory, 'installed'))).toEqual([])
  await manager.install!({ type: 'path', value: path })
  const entry = (await manager.list()).find(entry => entry.source)!
  reload.mockRejectedValueOnce(new Error('restart failed'))
  await expect(manager.remove!(entry.module)).rejects.toThrow('restart failed')
  expect(await manager.list()).toContainEqual(expect.objectContaining({ module: entry.module }))
  expect(existsSync(join(directory, 'installed', entry.module.slice('external:'.length)))).toBe(true)
})

test('ZIP 경로 탈출과 URL 패키지 및 상대 경로는 선택과 원본 파일을 변경하지 않는다', async () => {
  const { directory } = fixture()
  const zip = join(directory, 'unsafe.zip')
  writeFileSync(zip, zipSync({ '../escaped': strToU8('bad') }))
  for (const source of [
    { type: 'zip', value: zip }, { type: 'path', value: './relative.mjs' },
    { type: 'npm', value: 'https://example.com/plugin.tgz' }, { type: 'npm', value: 'git+https://example.com/plugin' },
    { type: 'jsr', value: 'not-scoped' }
  ]) {
    await expect(manageRuntimePlugins(directory, { action: 'install', source } as PluginRequest)).rejects.toThrow()
    expect((await manageRuntimePlugins(directory, { action: 'list' }) as unknown[])).toHaveLength(10)
  }
  expect(existsSync(join(directory, 'escaped'))).toBe(false)
  expect(readdirSync(join(directory, 'installed'))).toEqual([])
})

test('npm과 JSR은 버전 지정과 실제 패키지 의존성 설치를 지원한다', async () => {
  const { directory, open } = fixture()
  const source = join(directory, 'registry-source')
  mkdirSync(source)
  const manifest = { name: '@jsr/test__plugin', version: '1.2.3', type: 'module', exports: './index.js', dependencies: { 'fixture-dependency': '2.3.4' } }
  writeFileSync(join(source, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(source, 'index.js'), 'import value from "fixture-dependency"; export default ctx => { ctx.provide("registryMarker", value) }')
  const npm = join(dirname(createRequire(import.meta.url).resolve('desktop-npm/package.json')), 'bin/npm-cli.js')
  const packed = spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json'], { cwd: source, encoding: 'utf8' })
  expect(packed.status, packed.stderr).toBe(0)
  const archive = readFileSync(join(source, JSON.parse(packed.stdout)[0].filename))
  const dependency = { name: 'fixture-dependency', version: '2.3.4', type: 'module', exports: './index.js' }
  const dep = join(directory, 'dependency')
  mkdirSync(dep)
  writeFileSync(join(dep, 'package.json'), JSON.stringify(dependency))
  writeFileSync(join(dep, 'index.js'), 'export default 123')
  const packedDep = spawnSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json'], { cwd: dep, encoding: 'utf8' })
  expect(packedDep.status, packedDep.stderr).toBe(0)
  const depArchive = readFileSync(join(dep, JSON.parse(packedDep.stdout)[0].filename))
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(decodeURIComponent(req.url!))
    if (req.url === '/package.tgz') res.end(archive)
    else if (req.url === '/dependency.tgz') res.end(depArchive)
    else {
      const pkg = req.url === '/fixture-dependency' ? dependency : manifest
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ name: pkg.name, 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: {
        ...pkg, dist: { tarball: `http://127.0.0.1:${(server.address() as { port: number }).port}/${pkg === manifest ? 'package' : 'dependency'}.tgz` }
      } } }))
    }
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  vi.stubEnv('npm_config_registry', registry)
  vi.stubEnv('npm_config_@jsr:registry', registry)
  vi.stubEnv('npm_config_cache', join(directory, 'npm-cache'))
  onTestFinished(() => { vi.unstubAllEnvs() })
  for (const source of [{ type: 'npm', value: '@jsr/test__plugin@1.2.3' }, { type: 'jsr', value: '@test/plugin@1.2.3' }] as const) {
    const transaction = await manageRuntimePlugins(directory, { action: 'install', source })
    if (Array.isArray(transaction)) throw new Error('Expected transaction')
    const entry = transaction.expected.at(-1)!
    expect(entry).toMatchObject({ enabled: false, version: '1.2.3', source })
    await manageRuntimePlugins(directory, { action: 'enable', module: entry.module, enabled: true })
    const host = await open()
    expect(host.ctx.get('registryMarker')).toBe(123)
    await host.dispose()
    await manageRuntimePlugins(directory, { action: 'enable', module: entry.module, enabled: false })
  }
  expect(requests).toContain('/@jsr/test__plugin')
  expect(requests).toContain('/package.tgz')
  expect(requests).toContain('/fixture-dependency')
}, 20_000)

function dshPackage(directory: string, patch: string, modules: Record<string, string>) {
  const source = join(directory, 'dsh-source')
  mkdirSync(source)
  const files = {
    'package.json': JSON.stringify({
      name: 'dsh-fixture', version: '1.0.0', type: 'module',
      exports: Object.fromEntries(Object.keys(modules).map(name => [`./${name}`, `./${name}.js`])),
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }
    }),
    'cordis.patch.yml': patch,
    ...Object.fromEntries(Object.entries(modules).map(([name, code]) => [`${name}.js`, code])),
    'client.js': 'throw new Error("DSH React client must not be imported")'
  }
  for (const [name, value] of Object.entries(files)) writeFileSync(join(source, name), value)
  const zip = join(directory, 'dsh.zip')
  writeFileSync(zip, zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)]))))
  return { source, zip }
}

test.each(['path', 'zip'] as const)('DSH %s 번들은 root export 없이 YAML 설정과 named apply 및 뒤쪽 서비스 주입을 적용하고 해제한다', async type => {
  const { directory, open } = fixture()
  const active = join(directory, 'active')
  const { source, zip } = dshPackage(directory, `
- insert:
  - id: consumer
    name: dsh-fixture/consumer
    config: { offset: 17 }
  - id: ignored
    name: dsh-fixture/not-exported
    disabled: true
- insert:
  - id: provider
    name: dsh-fixture/provider
    config: ${JSON.stringify({ value: 23, activePath: active })}
`, {
    consumer: `export const inject = ['dshFixtureValue'];
      export const Config = { '~standard': { version: 1, vendor: 'fixture', validate: value => ({ value: { ...value, label: 'defaulted' } }) } };
      export function apply(ctx, config) { ctx.provide('dshFixtureResult', { sum: ctx.get('dshFixtureValue') + config.offset, label: config.label }) }`,
    provider: `import { writeFileSync, rmSync } from 'node:fs';
      export function apply(ctx, config) {
        ctx.provide('dshFixtureValue', config.value);
        ctx.effect(() => { writeFileSync(config.activePath, 'active'); return () => rmSync(config.activePath) })
      }`
  })
  const transaction = await manageRuntimePlugins(directory, { action: 'install', source: { type, value: type === 'path' ? source : zip } })
  if (Array.isArray(transaction)) throw new Error('Expected transaction')
  const entry = transaction.expected.at(-1)!
  expect(entry).toMatchObject({ enabled: false, format: 'dsh', version: '1.0.0' })
  expect(existsSync(active)).toBe(false)
  await manageRuntimePlugins(directory, { action: 'enable', module: entry.module, enabled: true })
  const host = await open()
  expect(host.ctx.get('dshFixtureResult')).toEqual({ sum: 40, label: 'defaulted' })
  expect(readFileSync(active, 'utf8')).toBe('active')
  await host.dispose()
  expect(existsSync(active)).toBe(false)
  await manageRuntimePlugins(directory, { action: 'enable', module: entry.module, enabled: false })
  const disabled = await open()
  expect(disabled.ctx.get('dshFixtureResult')).toBeUndefined()
  expect(existsSync(active)).toBe(false)
  await disabled.dispose()
  const removed = await manageRuntimePlugins(directory, { action: 'remove', module: entry.module })
  if (Array.isArray(removed)) throw new Error('Expected transaction')
  await manageRuntimePlugins(directory, { action: 'finalize', ...removed })
  expect(existsSync(source)).toBe(true)
  expect(existsSync(join(directory, 'installed', entry.module.slice('external:'.length)))).toBe(false)
}, 20_000)

test.each([
  { code: "export const inject = ['dshLoader']; export function apply() { throw new Error('must not run') }", error: 'DSH host services unavailable: dshLoader' },
  { code: "export function apply() { throw new Error('DSH apply failed') }", error: 'DSH apply failed' }
])('DSH 활성화 오류 $error는 앞쪽 행의 효과를 해제하고 이전 선택과 호스트를 복구한다', async ({ code, error }) => {
  const { directory, open, invoke } = fixture()
  const active = join(directory, 'partial-dsh')
  const { source } = dshPackage(directory, `
- insert:
  - id: first
    name: dsh-fixture/first
    config: ${JSON.stringify({ activePath: active })}
  - { id: second, name: dsh-fixture/second }
`, {
    first: `import { writeFileSync, rmSync } from 'node:fs';
      export default (ctx, config) => { ctx.provide('partialDsh', true); ctx.effect(() => { writeFileSync(config.activePath, 'partial'); return () => rmSync(config.activePath) }) }`,
    second: code
  })
  let host = await open()
  const manager = createNativeRuntimePluginManager(invoke, async () => { await host.dispose(); host = await open() })
  await manager.install!({ type: 'path', value: source })
  const entry = (await manager.list()).find(entry => entry.source)!
  await expect(manager.setEnabled(entry.module, true)).rejects.toThrow(error)
  expect(host.ctx.get('partialDsh')).toBeUndefined()
  expect(existsSync(active)).toBe(false)
  expect((await manager.list()).find(item => item.module === entry.module)?.enabled).toBe(false)
}, 20_000)

test.each([
  ['- remove: [existing-host]', 'Only DSH bundle insert'],
  ['- insert:\n  - { name: dsh-fixture/main, config: [] }', 'Invalid or unsupported'],
  ['- insert:\n  - { id: same, name: dsh-fixture/main }\n  - { id: same, name: dsh-fixture/main }', 'Duplicate'],
  ['- insert: [', 'Invalid DSH bundle YAML']
])('DSH 설치에서 지원하지 않는 YAML %s를 거부하고 설치 파일과 선택을 남기지 않는다', async (patch, error) => {
  const { directory } = fixture()
  const { zip } = dshPackage(directory, patch, { main: 'throw new Error("must not import")' })
  await expect(manageRuntimePlugins(directory, { action: 'install', source: { type: 'zip', value: zip } })).rejects.toThrow(error)
  expect(existsSync(join(directory, 'bundled-selection.json'))).toBe(false)
  expect(readdirSync(join(directory, 'installed'))).toEqual([])
}, 20_000)

test('DSH patch 경로가 패키지 밖의 설치 매니페스트를 가리키면 등록하지 않는다', async () => {
  const { directory } = fixture()
  const { source } = dshPackage(directory, '- insert: []', {})
  const manifestPath = join(source, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh.bundle.patch = '../../package.json'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  await expect(manageRuntimePlugins(directory, { action: 'install', source: { type: 'path', value: source } })).rejects.toThrow('must stay inside its package')
  expect(existsSync(join(directory, 'bundled-selection.json'))).toBe(false)
  expect(readdirSync(join(directory, 'installed'))).toEqual([])
})
