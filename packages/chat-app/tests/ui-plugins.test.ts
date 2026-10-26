import { Context } from 'cordis'
import { SlotService } from '@keundal/ui-slots'
import type { RuntimePluginManager } from '@keundal/chat/platform'
import { computed, ref, type Ref } from 'vue'
import { afterEach, expect, test, vi } from 'vitest'
import { UIPluginManager, uiPluginCatalog, uiPlugins, type UIPluginEntry, type UIPluginSelections } from '../app/ui-plugins'

// The manager tests run on Node without Nuxt's SFC compiler. Registrations below still use real Cordis and slots.
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
vi.mock('@keundal/ui-tool/plugin', () => ({ apply() {} }))
vi.mock('@keundal/ui-trace/plugin', () => ({ apply() {} }))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture(options: {
  selections?: Ref<UIPluginSelections | null | undefined>
  feature?: (ctx: Context) => void
  platform?: RuntimePluginManager
  entries?: UIPluginEntry[]
} = {}) {
  const ctx = new Context()
  const slots = await ctx.plugin(SlotService)
  const selections = options.selections ?? ref<UIPluginSelections | null | undefined>()
  const stop = vi.fn(async () => {})
  const catalog: UIPluginEntry[] = [
    { module: '@keundal/ui-slots', required: true },
    { module: '@keundal/ui-layout', required: true, plugin: { inject: ['slots'], apply(ctx) {
      ctx.slots.register({ name: 'root', children: { 'page.home': 'single', 'page.settings': 'single' } }, {})
    } } },
    { module: '@keundal/ui-home', plugin: { inject: ['slots'], apply: options.feature ?? (ctx => {
      ctx.slots.inject('page.home', () => ctx.slots.register({ name: 'page.home' }, {}))
    }) } },
    { module: '@keundal/ui-agent-plugins', required: true, plugin: { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('page.settings', () => ctx.slots.register({ name: 'page.settings' }, {}))
    } } },
    ...options.entries ?? []
  ]
  const manager = new UIPluginManager(ctx, { selections, stop, platform: options.platform }, catalog)
  cleanups.push(async () => {
    await manager.close()
    await slots.dispose()
  })
  await manager.mount()
  return { ctx, manager, selections, stop }
}

test('번들 카탈로그는 기존 UI 플러그인을 모두 포함하고 관리 화면과 기반 서비스를 필수로 표시한다', () => {
  expect(uiPlugins).toHaveLength(14)
  expect(new Set(uiPluginCatalog.map(entry => entry.module)).size).toBe(16)
  expect(uiPluginCatalog.filter(entry => entry.required).map(entry => entry.module)).toEqual([
    '@keundal/ui-slots', '@keundal/ui-runtime', '@keundal/ui-layout', '@keundal/ui-settings', '@keundal/ui-agent-plugins'
  ])
  expect(uiPluginCatalog.every(entry => entry.module.startsWith('@keundal/ui-'))).toBe(true)
})

test('비활성화하면 슬롯 등록이 사라지고 다시 활성화하면 복원하며 관리 화면은 유지한다', async () => {
  const { ctx, manager, stop, selections } = await fixture()
  expect(ctx.slots.describe('page.home')).toHaveLength(1)
  stop.mockImplementationOnce(async () => {
    expect(ctx.slots.describe('page.home')).toHaveLength(1)
  })
  await manager.setEnabled('@keundal/ui-home', false)
  expect(ctx.slots.describe('page.home')).toEqual([])
  expect(ctx.slots.describe('page.settings')).toHaveLength(1)
  expect(selections.value).toEqual({ '@keundal/ui-home': false })
  await manager.setEnabled('@keundal/ui-home', true)
  expect(ctx.slots.describe('page.home')).toHaveLength(1)
  expect(stop).toHaveBeenCalledTimes(2)
  await manager.close()
  expect(ctx.slots.describe('root')).toEqual([])
  expect(ctx.slots.describe('page.home')).toEqual([])
  await expect(manager.setEnabled('@keundal/ui-home', true)).rejects.toThrow('closed')
})

test('저장한 비활성 선택으로 재구성하면 서버와 클라이언트의 초기 슬롯이 같고 필수 항목은 유지한다', async () => {
  const first = await fixture()
  await first.manager.setEnabled('@keundal/ui-home', false)
  const cookie = JSON.stringify({ ...first.selections.value, '@keundal/ui-layout': false })
  await first.manager.close()
  const server = await fixture({ selections: ref(JSON.parse(cookie)) })
  const browser = await fixture({ selections: ref(JSON.parse(cookie)) })
  expect(server.ctx.slots.describe('page.home')).toEqual([])
  expect(await browser.manager.list()).toEqual(await server.manager.list())
  expect(server.ctx.slots.describe('root')).toHaveLength(1)
  expect(server.ctx.slots.describe('page.settings')).toHaveLength(1)
  await browser.manager.setEnabled('@keundal/ui-home', true)
  expect(browser.ctx.slots.describe('page.home')).toHaveLength(1)
  await browser.manager.close()
  expect(browser.ctx.slots.describe('page.home')).toEqual([])
})

test('필수 항목 비활성화와 알 수 없는 모듈은 응답 중단이나 저장 전에 거부한다', async () => {
  const { manager, stop, selections } = await fixture()
  for (const module of ['@keundal/ui-slots', '@keundal/ui-layout', '@keundal/ui-agent-plugins']) {
    await expect(manager.setEnabled(module, false)).rejects.toThrow('Required')
  }
  await expect(manager.setEnabled('https://example.com/plugin.mjs', true)).rejects.toThrow('Unknown bundled')
  expect(stop).not.toHaveBeenCalled()
  expect(selections.value).toBeUndefined()
})

test('쿠키 저장이 실패하면 비활성화와 활성화의 슬롯 효과 및 이전 선택을 복원한다', async () => {
  const value = ref<UIPluginSelections | null | undefined>()
  let fail = false
  const selections = computed({
    get: () => value.value,
    set: next => {
      value.value = next
      if (fail) {
        fail = false
        throw new Error('cookie failed')
      }
    }
  })
  const { ctx, manager } = await fixture({ selections })
  fail = true
  await expect(manager.setEnabled('@keundal/ui-home', false)).rejects.toThrow('cookie failed')
  expect(ctx.slots.describe('page.home')).toHaveLength(1)
  expect(selections.value).toBeUndefined()
  await manager.setEnabled('@keundal/ui-home', false)
  fail = true
  await expect(manager.setEnabled('@keundal/ui-home', true)).rejects.toThrow('cookie failed')
  expect(ctx.slots.describe('page.home')).toEqual([])
  expect(selections.value).toEqual({ '@keundal/ui-home': false })
  await manager.setEnabled('@keundal/ui-home', true)
  expect(ctx.slots.describe('page.home')).toHaveLength(1)
})

test('활성화 중 실패하면 부분 등록을 정리하고 선택을 유지하며 오류 후 재시도할 수 있다', async () => {
  let fail = true
  const { ctx, manager, selections } = await fixture({
    selections: ref({ '@keundal/ui-home': false }),
    feature: ctx => {
      ctx.slots.register({ name: 'page.home' }, {})
      if (fail) throw new Error('activation failed')
    }
  })
  await expect(manager.setEnabled('@keundal/ui-home', true)).rejects.toThrow('activation failed')
  expect(ctx.slots.describe('page.home')).toEqual([])
  expect(selections.value).toEqual({ '@keundal/ui-home': false })
  expect((await manager.list()).find(entry => entry.module === '@keundal/ui-home')).toMatchObject({
    enabled: false, error: expect.stringContaining('activation failed')
  })
  expect(ctx.slots.describe('page.settings')).toHaveLength(1)
  fail = false
  await manager.setEnabled('@keundal/ui-home', true)
  expect(ctx.slots.describe('page.home')).toHaveLength(1)
  expect((await manager.list()).find(entry => entry.module === '@keundal/ui-home')?.error).toBeUndefined()
})

test('응답 중단 실패는 선택과 효과를 유지하며 동시에 요청한 변경은 순서대로 적용한다', async () => {
  const { ctx, manager, stop, selections } = await fixture()
  stop.mockRejectedValueOnce(new Error('stop failed'))
  await expect(manager.setEnabled('@keundal/ui-home', false)).rejects.toThrow('stop failed')
  expect(ctx.slots.describe('page.home')).toHaveLength(1)
  expect(selections.value).toBeUndefined()
  let release!: () => void
  stop.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const off = manager.setEnabled('@keundal/ui-home', false)
  const on = manager.setEnabled('@keundal/ui-home', true)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(stop).toHaveBeenCalledTimes(2)
  expect(ctx.slots.describe('page.home')).toHaveLength(1)
  release()
  await Promise.all([off, on])
  expect(stop).toHaveBeenCalledTimes(3)
  expect(ctx.slots.describe('page.home')).toHaveLength(1)
  expect(selections.value).toEqual({ '@keundal/ui-home': true })
})

test('플랫폼 카탈로그를 합쳐도 로컬 UI를 독립적으로 전환하고 플랫폼 변경 전에 응답을 중단한다', async () => {
  const records = [{ module: '@keundal/plugin-agent-chat', enabled: true }]
  const platform: RuntimePluginManager = {
    list: async () => records,
    setEnabled: vi.fn(async (_, enabled) => {
      records[0]!.enabled = enabled
    })
  }
  const { manager, ctx, stop } = await fixture({ platform })
  expect(await manager.list()).toContainEqual(records[0])
  await manager.setEnabled('@keundal/ui-home', false)
  expect(ctx.slots.describe('page.home')).toEqual([])
  expect(platform.setEnabled).not.toHaveBeenCalled()
  stop.mockImplementationOnce(async () => {
    expect(platform.setEnabled).not.toHaveBeenCalled()
  })
  await manager.setEnabled('@keundal/plugin-agent-chat', false)
  expect(platform.setEnabled).toHaveBeenCalledWith('@keundal/plugin-agent-chat', false)
  expect((await manager.list()).at(-1)?.enabled).toBe(false)
})

test('슬롯 소유자를 끄면 하위 등록도 사라지고 다시 켜면 활성 확장의 등록을 복원한다', async () => {
  const { ctx, manager } = await fixture({
    feature: ctx => {
      ctx.slots.register({ name: 'page.home', children: { 'chat.message.footer': 'list' } }, {})
    },
    entries: [{ module: '@keundal/ui-trace', plugin: { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('chat.message.footer', () => ctx.slots.register({ name: 'chat.message.footer', id: 'trace' }, {}))
    } } }]
  })
  expect(ctx.slots.describe('chat.message.footer')).toHaveLength(1)
  await manager.setEnabled('@keundal/ui-home', false)
  expect(ctx.slots.describe('chat.message.footer')).toEqual([])
  await manager.setEnabled('@keundal/ui-home', true)
  expect(ctx.slots.describe('chat.message.footer')).toHaveLength(1)
  await manager.setEnabled('@keundal/ui-trace', false)
  expect(ctx.slots.describe('chat.message.footer')).toEqual([])
  await manager.setEnabled('@keundal/ui-home', false)
  await manager.setEnabled('@keundal/ui-home', true)
  expect(ctx.slots.describe('chat.message.footer')).toEqual([])
  await manager.setEnabled('@keundal/ui-trace', true)
  expect(ctx.slots.describe('chat.message.footer')).toHaveLength(1)
})

test('초기 선택의 선택적 플러그인이 실패해도 부분 효과를 정리하고 관리 화면을 등록한다', async () => {
  const { ctx, manager, selections } = await fixture({ feature: ctx => {
    ctx.slots.register({ name: 'page.home' }, {})
    throw new Error('startup activation failed')
  } })
  expect(ctx.slots.describe('page.home')).toEqual([])
  expect(ctx.slots.describe('page.settings')).toHaveLength(1)
  expect(selections.value).toBeUndefined()
  expect((await manager.list()).find(entry => entry.module === '@keundal/ui-home')).toMatchObject({
    enabled: false, error: expect.stringContaining('startup activation failed')
  })
})
