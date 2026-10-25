import { expect, test } from 'vitest'
import { BrowserAgentPluginManager } from '@keundal/plugin-chat-browser/plugins'
import { BrowserRuntimePluginManager } from '@keundal/plugin-chat-browser'
import { Context } from 'cordis'
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

declare module 'cordis' {
  interface Events {
    'test/plugin-output'(output: string[]): void
  }
}

test('Cordis 플러그인은 비활성으로 설치하고 활성화·복원·비활성화·삭제에 따라 효과를 등록하고 해제한다', async () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) }
  }
  const ctx = new Context()
  const module = 'https://example.com/report.mjs'
  const load = async () => ({
    report: (ctx: Context, config: { prefix: string }) => {
      ctx.on('test/plugin-output', output => { output.push(config.prefix) })
    }
  })
  const manager = new BrowserRuntimePluginManager(storage, load)
  await manager.attach(ctx)
  await manager.install({ module, export: 'report', config: { prefix: 'Report' } })
  const output: string[] = []
  ctx.emit('test/plugin-output', output)
  expect(output).toEqual([])
  expect((await manager.list())[0]).toMatchObject({ enabled: false })
  await manager.setEnabled(module, true)
  ctx.emit('test/plugin-output', output)
  expect(output).toEqual(['Report'])
  await manager.close()
  const restored = new BrowserRuntimePluginManager(storage, load)
  await restored.attach(ctx)
  ctx.emit('test/plugin-output', output)
  expect(output).toEqual(['Report', 'Report'])
  await restored.setEnabled(module, false)
  ctx.emit('test/plugin-output', output)
  expect(output).toEqual(['Report', 'Report'])
  expect((await restored.list())[0]).toMatchObject({ module, enabled: false, config: { prefix: 'Report' } })
  await restored.setEnabled(module, true)
  await restored.remove(module)
  ctx.emit('test/plugin-output', output)
  expect(output).toHaveLength(2)
  expect(await new BrowserRuntimePluginManager(storage, load).list()).toEqual([])
  await restored.close()
})

test('Cordis 활성화와 저장 실패는 효과를 정리하고 깨진 모듈이 있어도 관리 화면을 열 수 있다', async () => {
  let saved: string | null = null
  let writable = true
  const storage = {
    getItem: () => saved,
    setItem: (_: string, value: string) => {
      if (!writable) throw new Error('quota')
      saved = value
    }
  }
  const module = 'https://example.com/plugin.mjs'
  const ctx = new Context()
  let failActivation = false
  const load = async () => ({ default: (ctx: Context) => {
    ctx.on('test/plugin-output', output => { output.push('active') })
    if (failActivation) throw new Error('activation failed')
  } })
  const manager = new BrowserRuntimePluginManager(storage, load)
  await manager.attach(ctx)
  await expect(manager.install({ module: 'data:text/javascript,export default 1' })).rejects.toThrow('HTTPS')
  await expect(manager.install({ module: 'https://user:password@example.com/plugin.mjs' })).rejects.toThrow('credentials')
  await manager.install({ module })
  await expect(manager.install({ module })).rejects.toThrow('already installed')
  writable = false
  await expect(manager.setEnabled(module, true)).rejects.toThrow('quota')
  const output: string[] = []
  ctx.emit('test/plugin-output', output)
  expect(output).toEqual([])
  expect((await manager.list())[0]!.enabled).toBe(false)
  writable = true
  failActivation = true
  await expect(manager.setEnabled(module, true)).rejects.toThrow('activation failed')
  ctx.emit('test/plugin-output', output)
  expect(output).toEqual([])
  failActivation = false
  await manager.setEnabled(module, true)
  await manager.close()
  let unavailable = true
  const broken = new BrowserRuntimePluginManager(storage, async () => {
    if (unavailable) throw new Error('module unavailable')
    return load()
  })
  await expect(broken.attach(ctx)).resolves.toBeUndefined()
  expect((await broken.list())[0]).toMatchObject({ enabled: true, error: 'module unavailable' })
  unavailable = false
  await broken.attach(ctx)
  expect((await broken.list())[0]).toMatchObject({ enabled: true, error: undefined })
  ctx.emit('test/plugin-output', output)
  expect(output).toEqual(['active'])
  unavailable = true
  await broken.setEnabled(module, false)
  expect((await broken.list())[0]).toMatchObject({ enabled: false, error: undefined })
  await expect(broken.setEnabled(module, true)).rejects.toThrow('module unavailable')
  expect((await broken.list())[0]!.enabled).toBe(false)
  await broken.close()
})
