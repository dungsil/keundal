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
vi.mock('@keundal/ui-agent-plugins/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-chat/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-chat-list/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-composer/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-dictation/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-home/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-layout/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-mcp/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-model-selection/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-settings/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-settings-llm/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-skill/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-subagents/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-tool/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-trace/plugin', () => ({ apply() {} }))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

function platform() {
  const records: RuntimePluginInfo[] = [
    { module: '@keundal/plugin-agent-chat', enabled: true, required: true },
    { module: '@keundal/plugin-skill', enabled: true, feature: 'skills' },
    { module: '@keundal/plugin-mcp-client', enabled: true, feature: 'mcp' },
    { module: '@keundal/plugin-tool-chat', enabled: true }
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
} = {}) {
  const ctx = new Context()
  const slots = await ctx.plugin(SlotService)
  const stop = vi.fn(async () => {})
  const catalog: UIPluginEntry[] = [
    { module: '@keundal/ui-layout', plugin: { inject: ['slots'], apply(ctx) {
      ctx.slots.register({ name: 'root', children: {
        'page.feature': 'single', 'page.settings': 'single', 'page.mcp': 'single', 'page.tool': 'single'
      } }, {})
    } } },
    { module: '@keundal/ui-skill', feature: 'skills', plugin: { inject: ['slots'], apply: options.feature ?? (ctx => {
      ctx.slots.inject('page.feature', () => ctx.slots.register({ name: 'page.feature' }, {}))
    }) } },
    { module: '@keundal/ui-agent-plugins', plugin: { inject: ['slots'], apply(ctx) {
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
  const manager = new UIPluginManager(ctx, { stop, platform: runtime }, catalog)
  cleanups.push(async () => {
    await manager.close()
    await slots.dispose()
  })
  await manager.mount()
  return { ctx, manager, stop }
}

test('기능 카탈로그만 노출하며 UI 개별 전환과 필수 기능 비활성화는 거부한다', async () => {
  const runtime = platform()
  const { ctx, manager } = await fixture({ platform: runtime.manager })
  expect(await manager.list()).toEqual(runtime.records)
  for (const module of ['@keundal/ui-skill', '@keundal/ui-layout', '@keundal/ui-agent-plugins', 'https://example.com/plugin.mjs']) {
    await expect(manager.setEnabled(module, false)).rejects.toThrow('Unknown bundled')
  }
  await expect(manager.setEnabled('@keundal/plugin-agent-chat', false)).rejects.toThrow('Required')
  expect((await manager.list()).every(entry => entry.enabled)).toBe(true)
  expect(ctx.slots.describe('page.feature')).toHaveLength(1)
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
  await runtime.manager.setEnabled('@keundal/plugin-tool-chat', false)
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
  expect((await reopened.manager.list()).find(entry => entry.module === '@keundal/plugin-tool-chat')?.enabled).toBe(false)
  // A remote connection without a selection API keeps the default views, not local UI switches.
  await server.manager.sync()
  expect(await server.manager.list()).toEqual([])
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
  await expect(manager.setEnabled('@keundal/plugin-tool-chat', false)).rejects.toThrow('runtime failed')
  expect(ctx.slots.describe('page.tool')).toHaveLength(1)
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-tool-chat')?.enabled).toBe(true)
  runtime.manager.setEnabled = change
  await manager.setEnabled('@keundal/plugin-tool-chat', false)
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-tool-chat')).toMatchObject({ enabled: false })
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-tool-chat')?.error).toBeUndefined()
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
  expect((await manager.list()).find(entry => entry.module === '@keundal/plugin-skill')).toMatchObject({
    enabled: true, error: expect.stringContaining('startup activation failed')
  })
})
