import { Context } from 'cordis'
import { SlotService } from '@keundal/ui-slots'
import type { RuntimePluginInfo, RuntimePluginManager } from '@keundal/chat/platform'
import { afterEach, expect, test, vi } from 'vitest'
import { UIPluginManager, type UIPluginEntry } from '../app/ui-plugins'

declare module '@keundal/ui-slots' {
  interface SlotMap {
    'page.feature': { kind: 'single'; owner: Record<string, never> }
    'page.mcp': { kind: 'single'; owner: Record<string, never> }
    'page.tool': { kind: 'single'; owner: Record<string, never> }
  }
}

// Node has no Nuxt SFC compiler. The fixtures below still use real Cordis fibers and slots.
vi.mock('@keundal/ui-agent-plugins/plugin', () => ({ apply() {}, agentPluginSettings: { apply() {} } }))
vi.mock('@keundal/ui-chat/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-chat-list/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-chart/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-composer/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-dictation/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-home/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-layout/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-mcp/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-model-selection/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-settings/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-settings-llm/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-settings-llm/prompt-plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-skill/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-subagents/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-tool/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-trace/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-weather/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-workspace/plugin', () => ({ apply() {} }))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

function platform() {
  const records: RuntimePluginInfo[] = [
    { module: '@keundal/plugin-agent-chat', enabled: true },
    { module: '@keundal/plugin-skill', enabled: true, feature: 'skills' },
    { module: '@keundal/plugin-mcp-client', enabled: true, feature: 'mcp' },
    { module: '@keundal/plugin-tool-chart', enabled: true },
    { module: '@keundal/plugin-tool-weather', enabled: true }
  ]
  const manager: RuntimePluginManager = {
    list: async () => records,
    setEnabled: async (module, enabled) => { records.find(entry => entry.module === module)!.enabled = enabled }
  }
  return { records, manager }
}

async function fixture(options: {
  feature?: (ctx: Context) => void
  platform?: RuntimePluginManager | null
  entries?: UIPluginEntry[]
  storage?: Pick<Storage, 'getItem' | 'setItem'>
} = {}) {
  const ctx = new Context()
  const slots = await ctx.plugin(SlotService)
  const stop = vi.fn(async () => {})
  const catalog: UIPluginEntry[] = [
    { module: '@keundal/ui-layout', required: true, plugin: { inject: ['slots'], apply(ctx) {
      ctx.slots.register({ name: 'root', children: {
        'page.feature': 'single', 'page.settings': 'single', 'page.mcp': 'single', 'page.tool': 'single'
      } }, {})
    } } },
    { module: '@keundal/ui-skill', feature: 'skills', plugin: { inject: ['slots'], apply: options.feature ?? (ctx => {
      ctx.slots.inject('page.feature', () => ctx.slots.register({ name: 'page.feature' }, {}))
    }) } },
    { module: '@keundal/ui-agent-plugins', required: true, plugin: { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('page.settings', () => ctx.slots.register({ name: 'page.settings' }, {}))
    } } },
    { module: '@keundal/ui-mcp', feature: 'mcp', plugin: { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('page.mcp', () => ctx.slots.register({ name: 'page.mcp' }, {}))
    } } },
    { module: '@keundal/ui-tool', plugin: { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('page.tool', () => ctx.slots.register({ name: 'page.tool' }, {}))
    } } },
    ...options.entries ?? []
  ]
  const runtime = options.platform === null ? undefined : options.platform ?? platform().manager
  const manager = new UIPluginManager(ctx, { stop, platform: runtime, storage: options.storage }, catalog)
  cleanups.push(async () => {
    await manager.close()
    await slots.dispose()
  })
  await manager.mount()
  return { ctx, manager, stop }
}

test('실행과 UI 플러그인을 모두 노출하고 관리 화면만 비활성화를 거부한다', async () => {
  const runtime = platform()
  const { ctx, manager } = await fixture({ platform: runtime.manager })
  expect((await manager.list()).map(entry => entry.module)).toEqual([
    ...runtime.records.map(entry => entry.module), '@keundal/ui-layout', '@keundal/ui-skill',
    '@keundal/ui-agent-plugins', '@keundal/ui-mcp', '@keundal/ui-tool'
  ])
  for (const module of ['@keundal/ui-layout', '@keundal/ui-agent-plugins']) {
    await expect(manager.setEnabled(module, false)).rejects.toThrow('Required')
  }
  await expect(manager.setEnabled('https://example.com/plugin.mjs', true)).rejects.toThrow('Unknown bundled')
  await manager.setEnabled('@keundal/plugin-agent-chat', false)
  await manager.setEnabled('@keundal/ui-skill', false)
  expect(ctx.slots.describe('page.feature')).toEqual([])
  expect(ctx.slots.describe('page.settings')).toHaveLength(1)
})

test('기능을 끄고 켜면 대응 UI만 제거하고 복원하며 나중에 켠 UI도 종료할 때 정리한다', async () => {
  const { ctx, manager } = await fixture()
  await manager.setEnabled('@keundal/plugin-skill', false)
  expect(ctx.slots.describe('page.feature')).toEqual([])
  expect(ctx.slots.describe('page.mcp')).toHaveLength(1)
  expect(ctx.slots.describe('page.settings')).toHaveLength(1)
  await manager.setEnabled('@keundal/plugin-mcp-client', false)
  expect(ctx.slots.describe('page.mcp')).toEqual([])
  expect(ctx.slots.describe('page.tool')).toHaveLength(1)
  await manager.setEnabled('@keundal/plugin-skill', true)
  expect(ctx.slots.describe('page.feature')).toHaveLength(1)
  expect(ctx.slots.describe('page.mcp')).toEqual([])
  await manager.close()
  for (const slot of ['root', 'page.feature', 'page.settings', 'page.tool'] as const) expect(ctx.slots.describe(slot)).toEqual([])
  await expect(manager.setEnabled('@keundal/plugin-skill', true)).rejects.toThrow('closed')
})

test('서버와 클라이언트의 초기 UI는 같고 동기화 후 저장된 기능 선택만 반영한다', async () => {
  const runtime = platform()
  await runtime.manager.setEnabled('@keundal/plugin-skill', false)
  await runtime.manager.setEnabled('@keundal/plugin-tool-chart', false)
  await runtime.manager.setEnabled('@keundal/plugin-tool-weather', false)
  const server = await fixture({ platform: null })
  const browser = await fixture({ platform: runtime.manager })
  for (const slot of ['page.feature', 'page.mcp', 'page.tool'] as const) {
    expect(server.ctx.slots.describe(slot)).toHaveLength(1)
    expect(browser.ctx.slots.describe(slot)).toHaveLength(1)
  }
  await browser.manager.sync()
  expect(browser.ctx.slots.describe('page.feature')).toEqual([])
  expect(browser.ctx.slots.describe('page.tool')).toHaveLength(1)
  expect(browser.ctx.slots.describe('page.mcp')).toHaveLength(1)
  expect(browser.ctx.slots.describe('page.settings')).toHaveLength(1)
  await browser.manager.setEnabled('@keundal/plugin-skill', true)
  const reopened = await fixture({ platform: runtime.manager })
  await reopened.manager.sync()
  expect(reopened.ctx.slots.describe('page.feature')).toHaveLength(1)
  expect(reopened.ctx.slots.describe('page.tool')).toHaveLength(1)
  expect((await reopened.manager.list()).find(entry => entry.module === '@keundal/plugin-tool-chart')?.enabled).toBe(false)
  expect((await reopened.manager.list()).find(entry => entry.module === '@keundal/plugin-tool-weather')?.enabled).toBe(false)
  // A remote connection still exposes local UI selections, never server execution controls.
  await server.manager.sync()
  expect((await server.manager.list()).every(entry => entry.module.startsWith('@keundal/ui-'))).toBe(true)
  expect(server.ctx.slots.describe('page.feature')).toHaveLength(1)
})

test('기능 변경이 실패하면 대응 UI를 유지하고 UI 활성화 실패는 기능 선택까지 복원한다', async () => {
  const runtime = platform()
  let fail = false
  const { ctx, manager } = await fixture({ platform: runtime.manager, feature: ctx => {
    ctx.slots.register({ name: 'page.feature' }, {})
    if (fail) throw new Error('activation failed')
  } })
  const change = runtime.manager.setEnabled
  runtime.manager.setEnabled = async () => { throw new Error('runtime failed') }
  await expect(manager.setEnabled('@keundal/plugin-tool-chart', false)).rejects.toThrow('runtime failed')
  expect(ctx.slots.describe('page.tool')).toHaveLength(1)
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-tool-chart')?.enabled).toBe(true)
  runtime.manager.setEnabled = change
  await manager.setEnabled('@keundal/plugin-tool-chart', false)
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-tool-chart')).toMatchObject({ enabled: false })
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-tool-chart')?.error).toBeUndefined()
  expect(ctx.slots.describe('page.tool')).toHaveLength(1)
  await manager.setEnabled('@keundal/plugin-skill', false)
  fail = true
  await expect(manager.setEnabled('@keundal/plugin-skill', true)).rejects.toThrow('activation failed')
  expect(ctx.slots.describe('page.feature')).toEqual([])
  expect(ctx.slots.describe('page.settings')).toHaveLength(1)
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-skill')).toMatchObject({
    enabled: false, error: expect.stringContaining('activation failed')
  })
  fail = false
  await manager.setEnabled('@keundal/plugin-skill', true)
  expect(ctx.slots.describe('page.feature')).toHaveLength(1)
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-skill')?.error).toBeUndefined()
})

test('응답 중단 실패는 기능과 UI를 유지하며 동시에 요청한 변경은 순서대로 적용한다', async () => {
  const { ctx, manager, stop } = await fixture()
  stop.mockRejectedValueOnce(new Error('stop failed'))
  await expect(manager.setEnabled('@keundal/plugin-skill', false)).rejects.toThrow('stop failed')
  expect(ctx.slots.describe('page.feature')).toHaveLength(1)
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-skill')?.enabled).toBe(true)
  let release!: () => void
  stop.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const off = manager.setEnabled('@keundal/plugin-skill', false)
  const on = manager.setEnabled('@keundal/plugin-skill', true)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(ctx.slots.describe('page.feature')).toHaveLength(1)
  release()
  await Promise.all([off, on])
  expect(ctx.slots.describe('page.feature')).toHaveLength(1)
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-skill')?.enabled).toBe(true)
})

test('대응 UI의 슬롯 소유자가 사라지면 하위 확장도 사라지고 기능을 다시 켜면 복원한다', async () => {
  const { ctx, manager } = await fixture({
    feature: ctx => {
      ctx.slots.register({ name: 'page.feature', children: { 'chat.message.footer': 'list' } }, {})
    },
    entries: [{ module: '@keundal/ui-trace', plugin: { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('chat.message.footer', () => ctx.slots.register({ name: 'chat.message.footer', id: 'trace' }, {}))
    } } }]
  })
  expect(ctx.slots.describe('chat.message.footer')).toHaveLength(1)
  await manager.setEnabled('@keundal/plugin-skill', false)
  expect(ctx.slots.describe('chat.message.footer')).toEqual([])
  await manager.setEnabled('@keundal/plugin-skill', true)
  expect(ctx.slots.describe('chat.message.footer')).toHaveLength(1)
})

test('초기 기능 UI가 실패해도 부분 효과를 정리하고 기능 항목에 오류를 표시하며 관리 화면은 유지한다', async () => {
  const { ctx, manager } = await fixture({ feature: ctx => {
    ctx.slots.register({ name: 'page.feature' }, {})
    throw new Error('startup activation failed')
  } })
  await manager.sync()
  expect(ctx.slots.describe('page.feature')).toEqual([])
  expect(ctx.slots.describe('page.settings')).toHaveLength(1)
  expect((await manager.list()).find(entry => entry.module === '@keundal/ui-skill')).toMatchObject({
    enabled: true, error: expect.stringContaining('startup activation failed')
  })
})

test('외부 설치 기능은 제공하는 실행 방식에서만 노출하고 설치와 삭제 전에 응답을 중단한다', async () => {
  const browser = await fixture()
  expect(browser.manager.install).toBeUndefined()
  expect(browser.manager.remove).toBeUndefined()
  const runtime = platform()
  runtime.manager.install = async source => {
    runtime.records.push({ module: 'external:example', source, enabled: false })
  }
  runtime.manager.remove = async module => {
    const index = runtime.records.findIndex(entry => entry.module === module)
    runtime.records.splice(index, 1)
  }
  const { manager, stop, ctx } = await fixture({ platform: runtime.manager })
  const source = { type: 'jsr', value: '@example/plugin@1.0.0' } as const
  stop.mockRejectedValueOnce(new Error('stop failed'))
  await expect(manager.install!(source)).rejects.toThrow('stop failed')
  expect((await manager.list()).some(entry => entry.source)).toBe(false)
  await manager.install!(source)
  expect(await manager.list()).toContainEqual(expect.objectContaining({ module: 'external:example', source, enabled: false }))
  await manager.setEnabled('external:example', true)
  expect((await manager.list()).find(entry => entry.source)?.enabled).toBe(true)
  await manager.remove!('external:example')
  expect((await manager.list()).some(entry => entry.source)).toBe(false)
  expect(ctx.slots.describe('page.feature')).toHaveLength(1)
  expect(ctx.slots.describe('page.settings')).toHaveLength(1)
})

test('의존 대상 중단은 UI 선택을 보존하고 독립 UI 선택은 재시작 뒤에도 유지한다', async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  const runtime = platform()
  const first = await fixture({ platform: runtime.manager, storage })
  await first.manager.setEnabled('@keundal/plugin-skill', false)
  expect((await first.manager.list()).find(entry => entry.module === '@keundal/ui-skill')).toMatchObject({
    enabled: true, requires: ['@keundal/ui-layout', '@keundal/plugin-skill'], blockedBy: ['@keundal/plugin-skill']
  })
  expect(first.ctx.slots.describe('page.feature')).toEqual([])
  await first.manager.setEnabled('@keundal/plugin-skill', true)
  expect(first.ctx.slots.describe('page.feature')).toHaveLength(1)
  await first.manager.setEnabled('@keundal/ui-skill', false)
  await first.manager.setEnabled('@keundal/plugin-skill', false)
  await first.manager.setEnabled('@keundal/plugin-skill', true)
  expect(first.ctx.slots.describe('page.feature')).toEqual([])
  const reopened = await fixture({ platform: runtime.manager, storage })
  await reopened.manager.sync()
  expect(reopened.ctx.slots.describe('page.feature')).toEqual([])
  expect((await reopened.manager.list()).find(entry => entry.module === '@keundal/plugin-skill')?.enabled).toBe(true)
  await reopened.manager.setEnabled('@keundal/ui-skill', true)
  expect(reopened.ctx.slots.describe('page.feature')).toHaveLength(1)
})
