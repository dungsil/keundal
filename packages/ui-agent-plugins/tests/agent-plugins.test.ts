import { expect, test } from 'vitest'
import { BrowserAgentPluginManager } from '@keundal/plugin-chat-browser/plugins'
import { BrowserRuntimePluginManager } from '@keundal/plugin-chat-browser'
import { reactive } from 'vue'
import { importPluginDirectory } from '../app/lib/plugin-import'

const markdown = '---\nname: review\ndescription: Review reports\n---\nCheck the totals.'
const files = {
  'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'reports' }),
  'skills/review/SKILL.md': markdown,
  'mcp.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {
    remote: { type: 'streamable-http', url: 'https://example.com/mcp' }
  } })
}

test('폴더에서 플러그인 구성요소만 가져오고 보조 파일은 읽지 않는다', async () => {
  const selected = Object.entries({ ...files, 'scripts/run.sh': 'not imported' }).map(([path, content]) => ({
    webkitRelativePath: `reports/${path}`, size: content.length,
    text: async () => {
      if (path.startsWith('scripts/')) throw new Error('not text')
      return content
    }
  }))
  expect(await importPluginDirectory(selected)).toEqual(files)
  await expect(importPluginDirectory([])).rejects.toThrow('plugin.json')
  await expect(importPluginDirectory([{ ...selected[0]!, size: 4 * 1024 * 1024 + 1 }])).rejects.toThrow('4 MiB')
})

test('가져온 플러그인은 기본 비활성이며 활성화·새로고침·비활성화·삭제를 스킬 공급자에 반영한다', async () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) }
  }
  const manager = new BrowserAgentPluginManager(storage)
  const stop = async () => {}
  await manager.import(files, stop)
  expect((await manager.list())[0]).toMatchObject({ name: 'reports', enabled: false, permissions: {}, skills: ['review'] })
  expect((await manager.provider.prepare()).skills).toEqual([])
  await expect(manager.tools()).resolves.toEqual([])
  await manager.configure('reports', reactive({ enabled: true, permissions: { remote: { tools: [] } } }), stop)
  const restored = new BrowserAgentPluginManager(storage)
  const catalog = await restored.provider.prepare()
  expect(catalog.skills).toEqual([{ name: 'review', description: 'Review reports' }])
  expect(await catalog.load('review')).toEqual({ name: 'review', description: 'Review reports', content: markdown })
  // An enabled plugin without MCP permissions must not even connect to its server.
  await expect(restored.tools()).resolves.toEqual([])
  await restored.import({ ...files, 'plugin.json': files['plugin.json'].replace('reports', 'other'), 'skills/review/SKILL.md': markdown + '\nOther instructions.' }, stop)
  await restored.configure('other', { enabled: true, permissions: {} }, stop)
  const combined = await restored.provider.prepare()
  expect(combined.skills).toHaveLength(1)
  expect((await combined.load('review'))?.content).toBe(markdown)
  await restored.configure('reports', { enabled: false, permissions: {} }, stop)
  expect((await (await restored.provider.prepare()).load('review'))?.content).toContain('Other instructions.')
  await restored.remove('other', stop)
  expect((await restored.provider.prepare()).skills).toEqual([])
  await restored.remove('reports', stop)
  expect(await new BrowserAgentPluginManager(storage).list()).toEqual([])
  await manager.close()
  await restored.close()
})

test('중복 가져오기와 응답 중단 실패는 저장된 플러그인을 바꾸지 않는다', async () => {
  let saved: string | null = null
  const manager = new BrowserAgentPluginManager({
    getItem: () => saved,
    setItem: (_, value) => { saved = value }
  })
  await manager.import(files, async () => {})
  await expect(manager.import(files, async () => {})).rejects.toThrow('already installed')
  await expect(manager.configure('reports', { enabled: true, permissions: {} }, async () => {
    throw new Error('stop failed')
  })).rejects.toThrow('stop failed')
  expect((await manager.list())[0]!.enabled).toBe(false)
})

test('번들 목록만 선택하고 비활성 선택을 복원하며 필수 항목과 외부 모듈은 거부한다', async () => {
  const data = new Map<string, string>()
  data.set('keundal:runtime-plugins', JSON.stringify([{ module: 'https://example.com/old.mjs', enabled: true }]))
  data.set('keundal:bundled-plugins', JSON.stringify({ '@keundal/required': false, 'https://example.com/other.mjs': true }))
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) }
  }
  const catalog = [
    { module: '@keundal/required', enabled: true, required: true },
    { module: '@keundal/optional', enabled: true }
  ]
  const manager = new BrowserRuntimePluginManager(storage, catalog, async () => {})
  expect((await manager.list()).map(entry => entry.module)).toEqual(['@keundal/required', '@keundal/optional'])
  expect(manager.isEnabled('@keundal/required')).toBe(true)
  await expect(manager.setEnabled('@keundal/required', false)).rejects.toThrow('Required')
  for (const module of ['https://example.com/old.mjs', '/tmp/plugin.mjs', 'npm-package']) {
    await expect(manager.setEnabled(module, true)).rejects.toThrow('Unknown bundled')
  }
  expect('install' in manager).toBe(false)
  await manager.setEnabled('@keundal/optional', false)
  const restored = new BrowserRuntimePluginManager(storage, catalog, async () => {})
  expect(restored.isEnabled('@keundal/optional')).toBe(false)
  await restored.setEnabled('@keundal/optional', true)
  expect(restored.isEnabled('@keundal/optional')).toBe(true)
})

test('번들 선택의 저장이나 활성화가 실패하면 이전 실행 상태와 선택을 보존한다', async () => {
  let saved: string | null = null
  let writable = true
  let active = true
  let failActivation = false
  const storage = {
    getItem: () => saved,
    setItem: (_: string, value: string) => {
      if (!writable) throw new Error('quota')
      saved = value
    }
  }
  const module = '@keundal/optional'
  const manager = new BrowserRuntimePluginManager(storage, [{ module, enabled: true }], async (_, enabled) => {
    if (enabled && failActivation) throw new Error('activation failed')
    active = enabled
  })
  writable = false
  await expect(manager.setEnabled(module, false)).rejects.toThrow('quota')
  expect(active).toBe(true)
  expect(manager.isEnabled(module)).toBe(true)
  writable = true
  await manager.setEnabled(module, false)
  failActivation = true
  await expect(manager.setEnabled(module, true)).rejects.toThrow('activation failed')
  expect(active).toBe(false)
  expect((await manager.list())[0]).toMatchObject({ enabled: false, error: 'activation failed' })
  failActivation = false
  await manager.setEnabled(module, true)
  expect(active).toBe(true)
  expect((await manager.list())[0]).toMatchObject({ enabled: true, error: undefined })
})
