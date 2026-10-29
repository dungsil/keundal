import { expect, test } from 'vitest'
import { BrowserAgentPluginManager } from '@keundal/plugin-chat-browser/plugins'
import { BrowserRuntimePluginManager } from '@keundal/plugin-chat-browser'
import { reactive } from 'vue'
import { importPluginDirectory } from '../app/lib/plugin-import'

const markdown = '---\nname: review\ndescription: Review reports\n---\nCheck the totals.'
const files = {
  'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'reports' }),
  'skills/review/SKILL.md': markdown,
  'skills/review/references/guide.md': 'Review reference',
  'skills/review/assets/template.svg': '<svg/>',
  'skills/review/scripts/run.sh': 'echo must-not-execute',
  'mcp.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {
    remote: { type: 'streamable-http', url: 'https://example.com/mcp' }
  } })
}

test('폴더에서 스킬 보조 파일을 함께 가져오고 스킬 밖 파일은 제외한다', async () => {
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
  expect(await catalog.load('review')).toEqual({ name: 'review', description: 'Review reports', content: markdown,
    resources: ['assets/template.svg', 'references/guide.md', 'scripts/run.sh'] })
  expect(await catalog.readResource!('review', 'references/guide.md')).toBe('Review reference')
  expect(await catalog.readResource!('review', 'scripts/run.sh')).toBe('echo must-not-execute')
  await expect(catalog.readResource!('review', 'references/../../plugin.json')).rejects.toThrow('path')
  expect(await catalog.readResource!('review', 'assets/missing.svg')).toBeUndefined()
  // An enabled plugin without MCP permissions must not even connect to its server.
  await expect(restored.tools()).resolves.toEqual([])
  await restored.import({ ...files, 'plugin.json': files['plugin.json'].replace('reports', 'other'), 'skills/review/SKILL.md': markdown + '\nOther instructions.', 'skills/review/references/guide.md': 'Other reference' }, stop)
  await restored.configure('other', { enabled: true, permissions: {} }, stop)
  const combined = await restored.provider.prepare()
  expect(combined.skills).toHaveLength(1)
  expect((await combined.load('review'))?.content).toBe(markdown)
  expect(await combined.readResource!('review', 'references/guide.md')).toBe('Review reference')
  await restored.configure('reports', { enabled: false, permissions: {} }, stop)
  const fallback = await restored.provider.prepare()
  expect((await fallback.load('review'))?.content).toContain('Other instructions.')
  expect(await fallback.readResource!('review', 'references/guide.md')).toBe('Other reference')
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

test('업데이트를 검토한 파일로만 교체하고 활성화 설정과 기존 MCP 권한을 보존한다', async () => {
  let saved: string | null = null
  const storage = { getItem: () => saved, setItem: (_: string, value: string) => { saved = value } }
  const manager = new BrowserAgentPluginManager(storage)
  const stop = async () => {}
  await manager.import(files, stop)
  const permissions = { remote: { tools: ['search'], resources: ['reports://daily'] } }
  await manager.configure('reports', { enabled: true, permissions }, stop)
  const original = saved
  const next: Record<string, string> = {
    ...files,
    'plugin.json': JSON.stringify({ ...JSON.parse(files['plugin.json']), version: '2.0.0' }),
    'skills/review/SKILL.md': markdown + '\nUse the new guide.',
    'skills/review/references/new.md': 'New guide'
  }
  delete next['skills/review/references/guide.md']
  const review = await manager.previewUpdate('reports', reactive(next))
  expect(review).toMatchObject({ name: 'reports', previousVersion: undefined, version: '2.0.0', permissionRequests: [] })
  expect(review.changes).toEqual([
    { path: 'plugin.json', before: files['plugin.json'], after: next['plugin.json'] },
    { path: 'skills/review/SKILL.md', before: markdown, after: markdown + '\nUse the new guide.' },
    { path: 'skills/review/references/guide.md', before: 'Review reference', after: undefined },
    { path: 'skills/review/references/new.md', before: undefined, after: 'New guide' }
  ])
  expect(saved).toBe(original)
  expect((await (await manager.provider.prepare()).load('review'))?.content).toBe(markdown)
  // Neither caller-owned files nor the displayed review can change the staged version.
  next['skills/review/SKILL.md'] = 'unreviewed'
  review.changes[1]!.after = 'unreviewed'
  await manager.update(review.id, {}, stop)
  const restored = new BrowserAgentPluginManager(storage)
  expect((await restored.list())[0]).toMatchObject({ version: '2.0.0', enabled: true, permissions })
  const catalog = await restored.provider.prepare()
  expect((await catalog.load('review'))?.content).toBe(markdown + '\nUse the new guide.')
  expect(await catalog.readResource!('review', 'references/guide.md')).toBeUndefined()
  expect(await catalog.readResource!('review', 'references/new.md')).toBe('New guide')
  await expect(manager.update(review.id, {}, stop)).rejects.toThrow('Review')
})

test('새 서버와 연결 정보가 바뀐 서버만 다시 승인하며 미승인 권한은 부여하지 않는다', async () => {
  let saved: string | null = null
  const manager = new BrowserAgentPluginManager({ getItem: () => saved, setItem: (_, value) => { saved = value } })
  const stop = async () => {}
  await manager.import(files, stop)
  await manager.configure('reports', { enabled: false, permissions: { remote: { tools: '*', resources: '*' } } }, stop)
  const next = { ...files, 'mcp.json': JSON.stringify({
    ...JSON.parse(files['mcp.json']), mcpServers: {
      // A credential change at the same URL also needs approval.
      remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Account': 'other' } },
      added: { type: 'streamable-http', url: 'https://new.example.com/mcp' }
    }
  }) }
  const review = await manager.previewUpdate('reports', next)
  expect(review.permissionRequests).toEqual([
    { name: 'remote', previousUrl: 'https://example.com/mcp', url: 'https://example.com/mcp' },
    { name: 'added', previousUrl: undefined, url: 'https://new.example.com/mcp' }
  ])
  await manager.update(review.id, { added: { tools: ['lookup'] } }, stop)
  expect((await manager.list())[0]).toMatchObject({ enabled: false, permissions: { remote: {}, added: { tools: ['lookup'] } } })
  const moved = await manager.previewUpdate('reports', { ...next, 'mcp.json': next['mcp.json'].replace('https://example.com/mcp', 'https://moved.example.com/mcp') })
  expect(moved.permissionRequests).toEqual([{ name: 'remote', previousUrl: 'https://example.com/mcp', url: 'https://moved.example.com/mcp' }])
  await manager.update(moved.id, { remote: { resources: ['reports://monthly'] } }, stop)
  expect((await manager.list())[0]!.permissions).toEqual({ remote: { resources: ['reports://monthly'] }, added: { tools: ['lookup'] } })
})

test('검증·중단·저장 실패와 오래된 검토는 설치된 버전과 권한을 바꾸지 않는다', async () => {
  let saved: string | null = null
  let writable = true
  const storage = {
    getItem: () => saved,
    setItem: (_: string, value: string) => { if (!writable) throw new Error('quota'); saved = value }
  }
  const manager = new BrowserAgentPluginManager(storage)
  const stop = async () => {}
  await manager.import(files, stop)
  await manager.configure('reports', { enabled: true, permissions: { remote: { tools: ['search'] } } }, stop)
  const original = saved
  const originalInfo = await manager.list()
  await expect(manager.previewUpdate('reports', { ...files, 'plugin.json': '{}' })).rejects.toThrow('schema')
  await expect(manager.previewUpdate('reports', { ...files, 'plugin.json': files['plugin.json'].replace('reports', 'other') })).rejects.toThrow('name')
  const invalid = await manager.previewUpdate('reports', { ...files, 'mcp.json': '{}' })
  expect(invalid.diagnostics).not.toEqual([])
  await expect(manager.update(invalid.id, {}, stop)).rejects.toThrow('diagnostics')
  const review = await manager.previewUpdate('reports', { ...files, 'skills/review/SKILL.md': markdown + '\nUpdated.' })
  await expect(manager.update(review.id, {}, async () => { throw new Error('stop failed') })).rejects.toThrow('stop failed')
  writable = false
  await expect(manager.update(review.id, {}, stop)).rejects.toThrow('quota')
  expect(saved).toBe(original)
  expect(await manager.list()).toEqual(originalInfo)
  expect(await new BrowserAgentPluginManager(storage).list()).toEqual(originalInfo)
  expect((await (await manager.provider.prepare()).load('review'))?.content).toBe(markdown)
  writable = true
  await manager.configure('reports', { enabled: false, permissions: originalInfo[0]!.permissions }, stop)
  await expect(manager.update(review.id, {}, stop)).rejects.toThrow('changed')
  const fresh = await manager.previewUpdate('reports', files)
  const replaced = await manager.previewUpdate('reports', files)
  await expect(manager.update(fresh.id, {}, stop)).rejects.toThrow('Review')
  let release!: () => void
  let entered!: () => void
  const stopping = new Promise<void>(resolve => { entered = resolve })
  const applying = manager.update(replaced.id, {}, () => new Promise<void>(resolve => { release = resolve; entered() }))
  await stopping
  await expect(manager.configure('reports', { enabled: true, permissions: {} }, stop)).rejects.toThrow('changed')
  release()
  await applying
  expect((await manager.list())[0]).toMatchObject({ enabled: false, permissions: originalInfo[0]!.permissions })
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
