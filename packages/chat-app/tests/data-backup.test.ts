import { exportDataBackup, parseDataBackup, readDataBackup, restoreDataBackup, loadPromptPresets } from '@keundal/chat'
import { defaultLLMSettings } from '@keundal/llm-settings'
import { EventType } from '@keundal/core'
import { toMessages } from '@keundal/chat/messages'
import { BrowserRuntimePluginManager, createBrowserSettingsStorage } from '@keundal/plugin-chat-browser'
import { McpManager, createBrowserMcpSettingsStorage } from '@keundal/plugin-chat-browser/mcp'
import { SkillManager } from '@keundal/plugin-chat-browser/skills'
import { ChatStore } from '@keundal/plugin-chat-local'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

async function setup(t: TestContext) {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
  const ctx = new Context()
  const fiber = await ctx.plugin(memoryStorePlugin)
  t.onTestFinished(() => fiber.dispose())
  const store = new ChatStore(ctx, async () => { throw new Error('Backup must not execute an agent') })
  const settings = createBrowserSettingsStorage(storage)
  const skills = new SkillManager(storage, {
    list: async () => ({ roots: ['C:\\skills'], files: [{ root: 'C:\\skills', path: 'C:\\skills\\review\\SKILL.md',
      markdown: '---\nname: review\ndescription: Review code\n---\nCheck public behavior.' }] }),
    read: async () => { throw new Error('No live skill read during backup') }
  })
  const mcp = new McpManager(createBrowserMcpSettingsStorage(storage))
  const plugins = new BrowserRuntimePluginManager(storage, [
    { module: '@keundal/plugin-tool-chart', enabled: true },
    { module: 'external', enabled: true, source: { type: 'path', value: 'C:\\plugin.mjs' } }
  ], async () => {})
  const platform = { settings, skills, mcp }
  return { ctx, platform, store, storage, plugins, values }
}

test('백업은 비밀 설정을 제외하고 대화·프리셋·로컬 스킬·기능 선택을 다른 저장소로 옮긴다', async (t) => {
  const source = await setup(t)
  const settings = defaultLLMSettings()
  settings.openai = { apiKey: 'synthetic-api-secret', baseURL: 'https://api.example.com/v1',
    headers: { authorization: 'synthetic-header-secret' }, models: ['custom'] }
  await source.platform.settings.save(settings)
  source.storage.setItem('keundal:system-prompt', 'Answer concisely.')
  source.storage.setItem('keundal:default-model', 'openai/custom')
  await source.plugins.setEnabled('@keundal/plugin-tool-chart', false)
  await source.platform.mcp.save([{ serverName: 'docs', transport: 'streamable-http',
    url: 'https://mcp.example.com/?token=synthetic-url-secret', headers: { authorization: 'synthetic-mcp-secret' },
    permissions: { tools: '*', resources: '*' } }], async () => {})
  await source.store.create('portable-chat', { id: 'question', role: 'user', parts: [{ type: 'text', text: 'Keep this question' }] }, 'openai/custom')
  await source.store.rename('portable-chat', 'Portable title')
  const snapshot = (await source.ctx.session.get('portable-chat'))!
  const original = (await source.store.get('portable-chat'))!
  const messages = [...original.messages, { id: 'reply', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'Saved answer' }] }]
  await source.ctx.session.commit({ threadId: 'portable-chat', expectedRevision: snapshot.revision,
    messages: toMessages(messages.slice(-1), original.model), state: { web: { ...original, messages } },
    generation: {
      request: { input: { threadId: 'portable-chat', runId: 'reply', state: {}, context: [], tools: [], messages: snapshot.messages },
        sessionRevision: snapshot.revision, model: 'custom', maxOutputTokens: 120 },
      status: 'completed', messages: [{ id: 'answer', role: 'assistant', content: 'Saved answer' }],
      journal: [
        { sequence: 0, event: { type: EventType.RUN_STARTED, threadId: 'portable-chat', runId: 'reply' } },
        { sequence: 1, event: { type: EventType.RUN_FINISHED, threadId: 'portable-chat', runId: 'reply' } }
      ]
    }
  })
  await source.store.vote('portable-chat', 'reply', true)
  const backup = readDataBackup(JSON.stringify(await exportDataBackup(source)))
  for (const secret of ['synthetic-api-secret', 'synthetic-header-secret', 'synthetic-url-secret', 'synthetic-mcp-secret', 'C:\\skills', 'C:\\plugin.mjs'])
    expect(JSON.stringify(backup)).not.toContain(secret)
  expect(backup.settings.mcp).toEqual([{ serverName: 'docs', transport: 'streamable-http',
    url: 'https://mcp.example.com/', permissions: { tools: [], resources: [] } }])
  expect(backup.settings.plugins).toEqual([{ module: '@keundal/plugin-tool-chart', enabled: false }])
  const target = await setup(t)
  await target.store.create('unrelated', { id: 'other-question', role: 'user', parts: [] }, 'openai/custom')
  let activeProviders = await target.platform.settings.load()
  const destination = { ...target, settingsChanged: async (settings: typeof activeProviders) => { activeProviders = settings } }
  expect(await restoreDataBackup(destination, backup)).toEqual([])
  expect(activeProviders).toEqual(backup.settings.providers)
  const restored = await target.store.get('portable-chat')
  expect(restored).toMatchObject({ title: 'Portable title', started: true,
    messages: [{ id: 'question', parts: [{ type: 'text', text: 'Keep this question' }] }, { id: 'reply', parts: [{ type: 'text', text: 'Saved answer' }] }],
    votes: [{ chatId: 'portable-chat', messageId: 'reply', isUpvoted: true }] })
  expect(Object.hasOwn(restored!, 'pendingRunId')).toBe(false)
  expect((await target.ctx.backup.export()).runs).toEqual(backup.history.runs)
  expect(await target.store.get('unrelated')).toBeDefined()
  expect(await target.platform.settings.load()).toEqual(backup.settings.providers)
  expect(target.platform.skills.load()).toEqual({ skills: [{ name: 'review', description: 'Review code',
    content: 'Check public behavior.', enabled: true }], disabledFiles: [], loadLocal: false })
  expect(loadPromptPresets(target.storage).presets[0]?.blocks[0]).toMatchObject({ content: 'Answer concisely.' })
  expect((await target.plugins.list())[0]?.enabled).toBe(false)
  const before = await target.ctx.backup.export()
  const saved = new Map(target.values)
  await expect(restoreDataBackup(target, backup)).rejects.toThrow('already')
  expect(await target.ctx.backup.export()).toEqual(before)
  expect(target.values).toEqual(saved)
})

test('미지원 버전·손상된 대화·인증 정보가 있는 파일은 거부하고 기록 저장 실패 시 설정을 되돌린다', async (t) => {
  const source = await setup(t)
  source.storage.setItem('keundal:system-prompt', 'Incoming prompt')
  await source.store.create('incoming', { id: 'q', role: 'user', parts: [] }, 'openai/custom')
  const backup = await exportDataBackup(source)
  expect(() => parseDataBackup({ ...backup, version: 2 })).toThrow()
  expect(() => readDataBackup('{broken')).toThrow()
  const damaged = structuredClone(backup)
  ;(damaged.history.threads[0]!.state as { web: { id: string } }).web.id = 'another-chat'
  expect(() => parseDataBackup(damaged)).toThrow('Invalid backup conversation')
  const credentials = structuredClone(backup)
  credentials.settings.providers.openai.apiKey = 'unexpected-secret'
  expect(() => parseDataBackup(credentials)).toThrow('credentials')
  const target = await setup(t)
  target.storage.setItem('keundal:system-prompt', 'Previous prompt')
  await target.platform.settings.save({ ...defaultLLMSettings(), openai: { apiKey: 'previous-secret', baseURL: '' } })
  const previousProviders = await target.platform.settings.load()
  const previousSkills = target.platform.skills.load()
  const previousPlugins = await target.plugins.list()
  const history = await target.ctx.backup.export()
  Object.defineProperty(target.store, 'backup', { value: {
    ...target.store.backup, import: async () => { throw new Error('Disk full') }
  } })
  let activeProviders = previousProviders
  await expect(restoreDataBackup({ ...target, settingsChanged: async settings => { activeProviders = settings } }, backup)).rejects.toThrow('Disk full')
  expect(activeProviders).toEqual(previousProviders)
  expect(await target.platform.settings.load()).toEqual(previousProviders)
  expect(target.platform.skills.load()).toEqual(previousSkills)
  expect(await target.plugins.list()).toEqual(previousPlugins)
  expect(await target.ctx.backup.export()).toEqual(history)
  expect(loadPromptPresets(target.storage).presets[0]?.blocks[0]).toMatchObject({ content: 'Previous prompt' })
})
