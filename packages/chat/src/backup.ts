import { parseRunBudget } from '@keundal/agent'
import { parseHistoryBackup, type HistoryBackup } from '@keundal/backup'
import { llmSettingsSchema, type LLMSettings } from '@keundal/llm-settings'
import { parseMcpServers, type McpClientConfig } from '@keundal/mcp'
import { parseSubagentRoles } from '@keundal/subagent'
import { z } from 'zod'

import type { ChatStoreLike } from './chat-store'
import { DOCUMENT_MEDIA_TYPES, MAX_DOCUMENT_CHARACTERS } from './file'
import { toMessages } from './messages'
import { DEFAULT_MODEL_KEY, MODEL_KEY, TITLE_MODEL_KEY } from './model-preferences'
import { resolveModel } from './models'
import type { ChatPlatform, RuntimePluginManager } from './platform'
import { loadPromptPresets, parsePromptPresetSettings, PROMPT_PRESETS_KEY } from './prompt-presets'
import { skillSettingsSchema } from './skills'

/** Bound both file reading and serialized output before allocating a large parsed object. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024

const preferencesSchema = z
  .object({
    locale: z.enum(['en', 'ko']),
    colorMode: z.enum(['system', 'light', 'dark']),
    webSearch: z.boolean(),
    reasoning: z.union([z.boolean(), z.enum(['low', 'medium', 'high', 'xhigh', 'max'])])
  })
  .strict()
export type BackupPreferences = z.infer<typeof preferencesSchema>

const model = z.string().refine((value) => {
  try {
    return !value || !!resolveModel(value)
  } catch {
    return false
  }
}, 'Invalid model preference')
const chatMessage = z.looseObject({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(
    z.union([
      z.looseObject({ type: z.enum(['text', 'reasoning']), text: z.string() }),
      z.looseObject({
        type: z.literal('file'),
        mediaType: z.string().startsWith('image/'),
        url: z.string().regex(/^(?:data:image\/|https?:\/\/)/),
        filename: z.string().optional()
      }),
      z.looseObject({
        type: z.literal('file'),
        mediaType: z.enum(DOCUMENT_MEDIA_TYPES),
        url: z.literal(''),
        filename: z.string().optional(),
        text: z
          .string()
          .min(1)
          .max(MAX_DOCUMENT_CHARACTERS)
          .refine((value) => !!value.trim())
      }),
      z.looseObject({
        type: z.literal('source-url'),
        sourceId: z.string(),
        url: z.string(),
        title: z.string().optional()
      }),
      z.looseObject({
        type: z.literal('data-keundal'),
        data: z.looseObject({ model: model, messages: z.array(z.unknown()) })
      }),
      z.looseObject({
        type: z.string().regex(/^tool-.+/),
        toolCallId: z.string().min(1),
        state: z.enum(['input-streaming', 'input-available', 'output-available', 'output-error'])
      })
    ])
  ),
  metadata: z.looseObject({ steeredRunId: z.string().optional() }).optional()
})
const chat = z.looseObject({
  id: z.string().min(1),
  title: z.string().nullable(),
  createdAt: z.iso.datetime(),
  model: model,
  messages: z.array(chatMessage),
  started: z.boolean(),
  isOwner: z.literal(true),
  visibility: z.literal('private'),
  votes: z.array(z.object({ chatId: z.string(), messageId: z.string(), isUpvoted: z.boolean() })),
  queue: z.array(chatMessage).optional(),
  pendingRunId: z.string().optional()
})
const envelope = z
  .object({
    format: z.literal('keundal-backup'),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    history: z.unknown(),
    settings: z
      .object({
        providers: llmSettingsSchema,
        promptPresets: z.unknown(),
        skills: skillSettingsSchema,
        subagentRoles: z.unknown(),
        runBudget: z.unknown().optional(),
        mcp: z.unknown(),
        preferences: preferencesSchema,
        plugins: z.array(z.object({ module: z.string().min(1), enabled: z.boolean() }).strict()),
        models: z.object({ selected: model, default: model, title: model }).strict()
      })
      .strict()
  })
  .strict()

export function parseDataBackup(value: unknown) {
  const parsed = envelope.parse(value)
  const providers = llmSettingsSchema.parse(parsed.settings.providers)
  if (Object.values(providers).some((provider) => provider.apiKey || Object.keys(provider.headers ?? {}).length))
    throw new Error('Backup provider credentials are not supported')
  const mcp = parseMcpServers(parsed.settings.mcp, false)
  if (
    mcp.some(
      (server) =>
        server.transport !== 'streamable-http' ||
        Object.keys(server.headers ?? {}).length ||
        new URL(server.url).search ||
        server.permissions?.tools === '*' ||
        server.permissions?.resources === '*' ||
        server.permissions?.tools?.length ||
        server.permissions?.resources?.length
    )
  )
    throw new Error('Backup MCP credentials and permissions are not supported')
  if (new Set(parsed.settings.plugins.map((entry) => entry.module)).size !== parsed.settings.plugins.length)
    throw new Error('Duplicate backup plugin selection')
  const history = parseHistoryBackup(parsed.history)
  for (const thread of history.threads) {
    if (!thread.state || typeof thread.state !== 'object' || !('web' in thread.state)) continue
    const web = chat.parse(thread.state.web)
    if (
      web.id !== thread.threadId ||
      !web.model ||
      new Set(web.messages.map((message) => message.id)).size !== web.messages.length ||
      web.votes.some(
        (vote) => vote.chatId !== web.id || !web.messages.some((message) => message.id === vote.messageId)
      ) ||
      web.queue?.some((message) => message.role !== 'user')
    )
      throw new Error('Invalid backup conversation')
    toMessages(web.messages as Parameters<typeof toMessages>[0], web.model)
    // A restored unsent or interrupted chat must never auto-start a new model request.
    delete web.pendingRunId
    thread.state.web = { ...web, started: true }
  }
  return {
    ...parsed,
    history,
    settings: {
      ...parsed.settings,
      providers,
      promptPresets: parsePromptPresetSettings(parsed.settings.promptPresets),
      subagentRoles: parseSubagentRoles(parsed.settings.subagentRoles),
      runBudget: parsed.settings.runBudget === undefined ? undefined : parseRunBudget(parsed.settings.runBudget),
      mcp
    }
  }
}

export type DataBackup = ReturnType<typeof parseDataBackup>

export function readDataBackup(text: string): DataBackup {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('Backup file exceeds 64 MiB')
  return parseDataBackup(JSON.parse(text))
}

const encryptedEnvelope = z
  .object({
    format: z.literal('keundal-backup-encrypted'),
    version: z.literal(1),
    kdf: z.literal('PBKDF2-SHA-256'),
    iterations: z.literal(600_000),
    cipher: z.literal('AES-256-GCM'),
    salt: z.string(),
    iv: z.string(),
    ciphertext: z.string()
  })
  .strict()
const encryptionContext = new TextEncoder().encode('keundal-backup-encrypted:1:PBKDF2-SHA-256:600000:AES-256-GCM')

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  return btoa(chunks.join(''))
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error('Invalid backup encoding')
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

async function backupKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (!password) throw new Error('Backup password is required')
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Keeps JSON v1 unchanged unless a password is explicitly supplied. */
export async function serializeDataBackup(value: unknown, password?: string): Promise<string> {
  let text = JSON.stringify(parseDataBackup(value))
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('Backup file exceeds 64 MiB')
  if (password !== undefined) {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
    const key = await backupKey(password, salt)
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encryptionContext, tagLength: 128 },
      key,
      new TextEncoder().encode(text)
    )
    text = JSON.stringify({
      format: 'keundal-backup-encrypted',
      version: 1,
      kdf: 'PBKDF2-SHA-256',
      iterations: 600_000,
      cipher: 'AES-256-GCM',
      salt: encodeBase64(salt),
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext))
    })
  }
  // Base64 expansion counts toward the same on-disk file limit.
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('Backup file exceeds 64 MiB')
  return text
}

/** No plaintext is returned until GCM authentication and the full backup validation succeed. */
export async function openDataBackup(text: string, password?: string): Promise<DataBackup> {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('Backup file exceeds 64 MiB')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'keundal-backup-encrypted')
    return parseDataBackup(value)
  const encrypted = encryptedEnvelope.parse(value)
  const salt = decodeBase64(encrypted.salt)
  const iv = decodeBase64(encrypted.iv)
  const ciphertext = decodeBase64(encrypted.ciphertext)
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid encrypted backup')
  const key = await backupKey(password ?? '', salt)
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encryptionContext, tagLength: 128 },
    key,
    ciphertext
  )
  return readDataBackup(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
}

interface BackupOptions {
  platform: Pick<ChatPlatform, 'settings' | 'skills' | 'mcp'>
  store: ChatStoreLike
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  plugins?: RuntimePluginManager
  preferences?: BackupPreferences
  settingsChanged?: (settings: LLMSettings) => Promise<void>
}

/** Only explicitly portable provider fields leave the credential store. */
function portableProviders(settings: LLMSettings): LLMSettings {
  return llmSettingsSchema.parse(
    Object.fromEntries(
      Object.entries(settings).map(([id, provider]) => [
        id,
        {
          name: provider.name,
          baseURL: provider.baseURL,
          models: provider.models,
          apiKey: ''
        }
      ])
    )
  )
}

function portableMcp(servers: readonly McpClientConfig[]) {
  return servers.flatMap((server) => {
    if (server.transport !== 'streamable-http') return []
    const url = new URL(server.url)
    url.search = ''
    return [
      {
        serverName: server.serverName,
        transport: server.transport,
        url: url.toString(),
        allowInsecureHttp: server.allowInsecureHttp,
        timeoutMs: server.timeoutMs,
        maxResultBytes: server.maxResultBytes,
        permissions: { tools: [], resources: [] }
      }
    ]
  })
}

export async function exportDataBackup(options: BackupOptions): Promise<DataBackup> {
  const { platform, store, storage, plugins } = options
  if (!store.backup) throw new Error('This store does not support backups')
  const skills = platform.skills.load()
  const portable = new Map(skills.skills.map((skill) => [skill.name, skill]))
  const files = await platform.skills.listFiles()
  for (const file of files.files) {
    if (!file.definition) throw new Error(`Cannot back up invalid skill: ${file.path}`)
    if (!portable.has(file.definition.name))
      portable.set(file.definition.name, {
        ...file.definition,
        enabled: skills.loadLocal && !skills.disabledFiles.includes(file.path)
      })
  }
  const backup = parseDataBackup({
    format: 'keundal-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    history: await store.backup.export(),
    settings: {
      providers: portableProviders(await platform.settings.load()),
      promptPresets: loadPromptPresets(storage),
      skills: { skills: [...portable.values()], loadLocal: false, disabledFiles: [] },
      subagentRoles: JSON.parse(storage.getItem('keundal:subagent-roles') ?? '[]'),
      runBudget:
        storage.getItem('keundal:run-budget') === null ? undefined : JSON.parse(storage.getItem('keundal:run-budget')!),
      mcp: portableMcp(platform.mcp.configuration),
      preferences: options.preferences ?? { locale: 'en', colorMode: 'system', webSearch: true, reasoning: 'medium' },
      plugins: ((await plugins?.list()) ?? [])
        .filter((entry) => !entry.source && !entry.required)
        .map(({ module, enabled }) => ({ module, enabled })),
      models: {
        selected: storage.getItem(MODEL_KEY) ?? '',
        default: storage.getItem(DEFAULT_MODEL_KEY) ?? '',
        title: storage.getItem(TITLE_MODEL_KEY) ?? ''
      }
    }
  })
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > MAX_BACKUP_BYTES)
    throw new Error('Backup file exceeds 64 MiB')
  return backup
}

/**
 * Settings are reversible and applied first. History is imported last, in one store transaction;
 * a collision or storage failure restores the previous settings rather than leaving a half import.
 */
export async function restoreDataBackup(options: BackupOptions, value: unknown, password?: string): Promise<string[]> {
  const backup = typeof value === 'string' ? await openDataBackup(value, password) : parseDataBackup(value)
  const { platform, store, storage, plugins } = options
  if (!store.backup) throw new Error('This store does not support backups')
  await store.stop()
  const current: HistoryBackup = await store.backup.export()
  const threadIds = new Set(current.threads.map((thread) => thread.threadId))
  const runIds = new Set(current.runs.map((run) => run.request.input.runId))
  if (
    backup.history.threads.some((thread) => threadIds.has(thread.threadId)) ||
    backup.history.runs.some((run) => runIds.has(run.request.input.runId))
  )
    throw new Error('Backup contains conversation or run IDs already in this store')
  const previousProviders = await platform.settings.load()
  const previousSkills = platform.skills.load()
  const previousMcp = platform.mcp.configuration
  const catalog = (await plugins?.list()) ?? []
  const undo: (() => void | Promise<void>)[] = []
  const skipped: string[] = []
  const write = (key: string, value: string | null) => {
    const previous = storage.getItem(key)
    undo.push(() => (previous === null ? storage.removeItem(key) : storage.setItem(key, previous)))
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, value)
  }
  try {
    undo.push(async () => {
      await platform.settings.save(previousProviders)
      await options.settingsChanged?.(previousProviders)
    })
    await platform.settings.save(backup.settings.providers)
    undo.push(() => {
      platform.skills.save(previousSkills)
    })
    platform.skills.save(backup.settings.skills)
    undo.push(() => platform.mcp.save(previousMcp, async () => {}))
    await platform.mcp.save(backup.settings.mcp, async () => {})
    write(PROMPT_PRESETS_KEY, JSON.stringify(backup.settings.promptPresets))
    write('keundal:subagent-roles', JSON.stringify(backup.settings.subagentRoles))
    write('keundal:run-budget', backup.settings.runBudget ? JSON.stringify(backup.settings.runBudget) : null)
    write(MODEL_KEY, backup.settings.models.selected || null)
    write(DEFAULT_MODEL_KEY, backup.settings.models.default || null)
    write(TITLE_MODEL_KEY, backup.settings.models.title || null)
    for (const selection of backup.settings.plugins) {
      const entry = catalog.find((entry) => entry.module === selection.module && !entry.source && !entry.required)
      if (!entry) {
        skipped.push(selection.module)
        continue
      }
      if (entry.enabled === selection.enabled) continue
      undo.push(() => plugins!.setEnabled(entry.module, entry.enabled))
      await plugins!.setEnabled(entry.module, selection.enabled)
    }
    await options.settingsChanged?.(backup.settings.providers)
    await store.backup.import(backup.history)
    return skipped
  } catch (error) {
    const failures: unknown[] = []
    for (const rollback of undo.toReversed()) {
      try {
        await rollback()
      } catch (failure) {
        failures.push(failure)
      }
    }
    if (failures.length)
      throw new AggregateError([error, ...failures], 'Restore failed and settings rollback was incomplete')
    throw error
  }
}
