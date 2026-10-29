import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { exportDataBackup, parseDataBackup, readDataBackup, restoreDataBackup, loadPromptPresets, serializeDataBackup, openDataBackup } from '@keundal/chat'
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
  const budget = { maxTokens: 12345, maxCost: { amount: 0.25, currency: 'USD' }, maxDurationMs: 2500, unknownPricing: 'reject' }
  source.storage.setItem('keundal:run-budget', JSON.stringify(budget))
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
  expect(target.storage.getItem('keundal:model')).toBeNull()
  expect(JSON.parse(target.storage.getItem('keundal:run-budget')!)).toEqual(budget)
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
  expect(() => parseDataBackup({ ...backup, settings: { ...backup.settings, runBudget: { maxTokens: 0 } } })).toThrow('budget')
  const target = await setup(t)
  target.storage.setItem('keundal:system-prompt', 'Previous prompt')
  target.storage.setItem('keundal:run-budget', JSON.stringify({ maxTokens: 6789 }))
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
  expect(JSON.parse(target.storage.getItem('keundal:run-budget')!)).toEqual({ maxTokens: 6789 })
  expect(loadPromptPresets(target.storage).presets[0]?.blocks[0]).toMatchObject({ content: 'Previous prompt' })
})

test('선택적 암호화는 JSON v1을 보존하고 매번 다른 파일로 대화와 설정을 보호한다', async (t) => {
  const source = await setup(t)
  source.storage.setItem('keundal:system-prompt', '비공개 지침 🔒')
  await source.store.create('encrypted-chat', { id: 'q', role: 'user', parts: [{ type: 'text', text: '비공개 대화' }] }, 'openai/custom')
  const backup = await exportDataBackup(source)
  const plain = await serializeDataBackup(backup)
  expect(JSON.parse(plain)).toEqual(JSON.parse(JSON.stringify(backup)))
  expect(await openDataBackup(plain)).toEqual(readDataBackup(plain))
  const password = ' 긴 비밀번호 🔑 with spaces '
  const text = await serializeDataBackup(backup, password)
  for (const secret of ['비공개 지침', '비공개 대화', 'encrypted-chat', backup.createdAt, password])
    expect(text).not.toContain(secret)
  expect(() => readDataBackup(text)).toThrow()
  const encrypted = JSON.parse(text)
  const second = JSON.parse(await serializeDataBackup(backup, password))
  for (const key of ['salt', 'iv', 'ciphertext']) expect(second[key]).not.toEqual(encrypted[key])
  // Independently decrypt with Node's implementation to check the portable file contract.
  const key = pbkdf2Sync(password, Buffer.from(encrypted.salt, 'base64'), 600_000, 32, 'sha256')
  const cipher = Buffer.from(encrypted.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'))
  decipher.setAAD(Buffer.from('keundal-backup-encrypted:1:PBKDF2-SHA-256:600000:AES-256-GCM'))
  decipher.setAuthTag(cipher.subarray(-16))
  expect(Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]).toString('utf8')).toEqual(plain)
  expect(await openDataBackup(text, password)).toEqual(readDataBackup(plain))
  const target = await setup(t)
  await target.store.create('existing', { id: 'old', role: 'user', parts: [] }, 'openai/custom')
  await restoreDataBackup(target, text, password)
  expect(await target.store.get('encrypted-chat')).toMatchObject({ messages: [{ parts: [{ text: '비공개 대화' }] }] })
  expect(await target.store.get('existing')).toBeDefined()
  expect(loadPromptPresets(target.storage).presets[0]?.blocks[0]).toMatchObject({ content: '비공개 지침 🔒' })
  await expect(serializeDataBackup(backup, '')).rejects.toThrow('password')
})

test('비밀번호 누락·오입력·변조·미지원 암호화는 기존 대화와 모든 설정을 바꾸지 않는다', async (t) => {
  const source = await setup(t)
  await source.store.create('incoming', { id: 'q', role: 'user', parts: [] }, 'openai/custom')
  const text = await serializeDataBackup(await exportDataBackup(source), 'correct password')
  const target = await setup(t)
  await target.store.create('existing', { id: 'old', role: 'user', parts: [] }, 'openai/custom')
  await target.platform.settings.save({ ...defaultLLMSettings(), openai: { apiKey: 'keep-me', baseURL: '' } })
  target.storage.setItem('keundal:system-prompt', 'Keep my settings')
  const history = await target.ctx.backup.export()
  const settings = new Map(target.values)
  const invalid = [text, text]
  for (const field of ['salt', 'iv', 'ciphertext']) {
    const damaged = JSON.parse(text)
    const bytes = Buffer.from(damaged[field], 'base64')
    bytes[0] = bytes[0]! ^ 1
    damaged[field] = bytes.toString('base64')
    invalid.push(JSON.stringify(damaged))
  }
  const tag = JSON.parse(text)
  const bytes = Buffer.from(tag.ciphertext, 'base64')
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
  tag.ciphertext = bytes.toString('base64')
  invalid.push(JSON.stringify(tag))
  for (const change of [{ version: 2 }, { iterations: 1 }, { cipher: 'AES-CBC' }, { salt: 'bad!' }, { iv: '' }, { ciphertext: '' }])
    invalid.push(JSON.stringify({ ...JSON.parse(text), ...change }))
  for (const [index, file] of invalid.entries()) {
    await expect(restoreDataBackup(target, file, index === 0 ? undefined : index === 1 ? 'wrong' : 'correct password')).rejects.toThrow()
    expect(await target.ctx.backup.export()).toEqual(history)
    expect(target.values).toEqual(settings)
  }
})
