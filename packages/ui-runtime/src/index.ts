import {
  loadPromptPresets,
  parsePromptPresetSettings,
  PROMPT_PRESETS_KEY,
  exportDataBackup,
  restoreDataBackup,
  parseDataBackup,
  type BackupPreferences,
  type PromptPresetSettings
} from '@keundal/chat'
import { listChatSummaries, type ChatStoreLike, type ChatSummary } from '@keundal/chat/chat-store'
import {
  DEFAULT_MODEL_KEY,
  MODEL_KEY,
  TITLE_MODEL_KEY,
  loadModelPreferences,
  readModelPreference,
  saveTitleModel
} from '@keundal/chat/model-preferences'
import { resolveModel, type ModelOption } from '@keundal/chat/models'
import type { ChatConnection, ChatPlatform, RuntimePluginManager } from '@keundal/chat/platform'
import { type ExecutionOptions } from '@keundal/core'
import { type Reasoning, type ReasoningLevel } from '@keundal/llm'
import {
  FALLBACK_MODEL,
  configuredProviders,
  defaultLLMSettings,
  providerCredentials,
  providerIcon,
  type LLMSettings
} from '@keundal/llm-settings'
import { type SkillSummary } from '@keundal/skill'
import { parseSubagentRoles, type SubagentRole } from '@keundal/subagent'
import type { TaskSnapshot } from '@keundal/task'
import type { CodingWorkspaceClient } from '@keundal/workspace'
import { useStorage } from '@vueuse/core'
import { Service, type Context } from 'cordis'
import { computed, effectScope, reactive, ref, shallowRef, watch, type Ref } from 'vue'

import { useModelCatalog, type ModelCatalog } from './model-catalog'
import { createModelSelection } from './model-selection'
import { reasoningLevels, selectedReasoning } from './reasoning-settings'

export { reasoningLevels, selectedReasoning } from './reasoning-settings'

declare module 'cordis' {
  interface Context {
    readonly chatRuntime: ChatRuntime
  }
}

export interface ChatCapabilities {
  /** Settings are kept in the OS secure storage instead of the browser. */
  secureSettings: boolean
  /** The platform can read skills from local files. */
  localSkills: boolean
}

export interface ChatRuntimeOptions {
  /** The application's chat platform. Absent while rendering on the server. */
  platform?: ChatPlatform
  capabilities: ChatCapabilities
  /** Browser storage for model preferences. Absent while rendering on the server. */
  storage?: Storage
  /**
   * Cookie-backed preferences, so the server renders the same prompt options. Unset cookies keep their defaults
   * without being written.
   */
  preferences: { webSearch: Ref<boolean | null | undefined>; reasoning: Ref<Reasoning | null | undefined> }
  /** Opens the settings of a provider whose credentials are missing. */
  openProviderSettings(provider: string): void
  /** Shows an error that has no other place on screen. */
  notifyError(message: string): void
  /** Localized fallback messages owned by the application. */
  messages: { modelsLoadFailed(): string; modelSwitchFailed(): string }
}

/** Saved settings could not be read; the application decides how to report it. */
export class SettingsLoadError extends Error {
  constructor(cause: unknown) {
    super('Could not load chat settings', { cause })
    this.name = 'SettingsLoadError'
  }
}

export type { ChatSummary }

const unavailable = (name: string) => new Error(`${name} is not available until the chat runtime starts in the browser`)

/**
 * Cordis service `chatRuntime`: the chat platform, its connection and the view state that several UI plugins share.
 *
 * The service exists on the server too, so plugins register the same entries there. Members that need the browser
 * platform throw until {@link ChatRuntime.start} connects.
 */
export class ChatRuntime extends Service {
  readonly capabilities: ChatCapabilities
  /** The shell's bundled UI catalog combined with the platform catalog, including on remote connections. */
  pluginManager?: RuntimePluginManager
  readonly settings: Ref<LLMSettings> = ref(defaultLLMSettings())
  readonly model = ref(FALLBACK_MODEL)
  readonly titleModel = ref('')
  readonly defaultModel = ref('')
  readonly promptPresets = ref<PromptPresetSettings>({ activePresetId: null, presets: [] })
  readonly promptPreset = computed(() =>
    this.promptPresets.value.presets.find((preset) => preset.id === this.promptPresets.value.activePresetId)
  )
  readonly subagentRoles = ref<SubagentRole[]>([])
  readonly switching = ref(false)
  readonly workspacesAvailable = ref(false)
  readonly webSearch = computed<boolean>({
    get: () => this.options.preferences.webSearch.value ?? true,
    set: (value) => {
      this.options.preferences.webSearch.value = value
    }
  })
  /** Work that keeps the startup screen visible, keyed by its owner. */
  readonly startup = reactive<Record<string, boolean>>({})
  readonly ready = computed(() => !this.switching.value && !Object.values(this.startup).some(Boolean))
  /** Conversations, newest first. `undefined` until loaded in the browser. */
  readonly chats = shallowRef<ChatSummary[]>()
  readonly reasoningLevels = computed(() => reasoningLevels(this.model.value))
  readonly reasoning = computed<ReasoningLevel>({
    get: () => selectedReasoning(this.options.preferences.reasoning.value ?? 'medium', this.reasoningLevels.value),
    set: (value) => {
      this.options.preferences.reasoning.value = value
    }
  })

  private readonly scope = effectScope(true)
  private readonly selectionError = ref('')
  private readonly remoteModels = shallowRef<ModelOption[]>()
  private catalog?: ModelCatalog
  private connection?: ChatConnection
  private disposal?: Promise<void>
  private unsubscribe?: () => void

  readonly models = computed<ModelOption[]>(() => {
    if (this.remoteModels.value) return this.remoteModels.value
    const available = this.catalog?.models.value ?? []
    const selected = resolveModel(this.model.value)
    if (available.some((item) => item.value === selected.value)) return available
    // Keep saved conversations usable even when discovery fails or a model is no longer listed.
    return [{ value: selected.value, label: selected.id, icon: providerIcon(selected.configuration) }, ...available]
  })

  readonly modelsLoading = computed(() => this.switching.value || !!this.catalog?.loading.value)
  readonly modelsError = computed(() => this.selectionError.value || this.catalog?.error.value || '')

  private readonly selection = createModelSelection({
    model: this.model,
    defaultModel: this.defaultModel,
    switching: this.switching,
    error: this.selectionError,
    storage: {
      setItem: (key, value) => this.options.storage?.setItem(key, value),
      removeItem: (key) => this.options.storage?.removeItem(key)
    },
    selectModel: (value) => this.connection?.selectModel?.(value) ?? Promise.resolve(),
    canSelectDefault: (value) =>
      !this.remoteModels.value || this.remoteModels.value.some((item) => item.value === value),
    onError: () => {
      this.selectionError.value = this.options.messages.modelSwitchFailed()
      this.options.notifyError(this.selectionError.value)
    }
  })

  readonly selectedModel = this.selection.selectedModel

  constructor(
    ctx: Context,
    private readonly options: ChatRuntimeOptions
  ) {
    super(ctx, 'chatRuntime')
    this.capabilities = options.capabilities
    ctx.effect(() => () => void this.dispose(), 'chatRuntime: connection')
  }

  /** The connected platform. Throws on the server. */
  get platform(): ChatPlatform {
    if (!this.options.platform) throw unavailable('The chat platform')
    return this.options.platform
  }

  /** The conversation store of the connection. Throws until connected. */
  get store(): ChatStoreLike {
    if (!this.connection) throw unavailable('The chat store')
    return this.connection.store
  }

  /** The connection runs the agent on a host rather than in the browser. */
  get remoteAgent(): boolean {
    return this.connection?.remoteAgent ?? false
  }

  get workspaces(): CodingWorkspaceClient {
    if (!this.connection?.workspaces) throw unavailable('Coding workspaces')
    return this.connection.workspaces
  }

  async listBackgroundTasks(): Promise<TaskSnapshot[]> {
    if (!this.connection?.tasks) throw unavailable('Background tasks')
    return this.connection.tasks.list()
  }

  async cancelBackgroundTask(id: string) {
    if (!this.connection?.tasks) throw unavailable('Background tasks')
    return this.connection.tasks.cancel(id)
  }

  /**
   * Load preferences and settings, then connect the platform. Call once in the browser before mounting.
   * @throws {SettingsLoadError} when saved settings cannot be read.
   */
  async start(): Promise<void> {
    const platform = this.platform
    const storage = this.options.storage
    if (!storage) throw unavailable('Browser storage')
    await platform.mcp.load()
    const preferences = loadModelPreferences(storage)
    this.defaultModel.value = preferences.defaultModel
    this.titleModel.value = readModelPreference(storage, TITLE_MODEL_KEY) ?? ''
    const initialModel = preferences.model
    this.model.value = initialModel || FALLBACK_MODEL
    try {
      this.promptPresets.value = loadPromptPresets(storage)
      this.subagentRoles.value = parseSubagentRoles(JSON.parse(storage.getItem('keundal:subagent-roles') ?? '[]'))
      this.settings.value = await platform.settings.load()
    } catch (error) {
      throw new SettingsLoadError(error)
    }
    this.scope.run(() => {
      useStorage(MODEL_KEY, this.model, storage, { writeDefaults: false })
      this.catalog = useModelCatalog(this.settings, platform.loadModels, this.options.messages.modelsLoadFailed)
    })
    const connection = await platform.connect({
      getSettings: () => this.settings.value,
      getModels: () => this.catalog?.models.value ?? [],
      initialModel:
        initialModel && this.settings.value[resolveModel(initialModel).configuration] ? initialModel : undefined,
      skills: platform.skills.providers
    })
    this.connection = connection
    this.workspacesAvailable.value = !!connection.workspaces
    if (connection.selectedModel) this.model.value = connection.selectedModel
    if (connection.remoteModels) {
      this.remoteModels.value = connection.remoteModels
      this.scope.run(() =>
        watch(
          this.remoteModels,
          (available) => {
            if (available?.length && !available.some((item) => item.value === this.model.value))
              this.model.value = available[0]!.value
          },
          { immediate: true }
        )
      )
    }
    this.unsubscribe = platform.settings.subscribe?.((value) => {
      this.settings.value = value
    })
    void this.refreshChats()
  }

  /** Mark work that keeps the startup screen visible. */
  setPending(key: string, pending: boolean): void {
    this.startup[key] = pending
  }

  /**
   * Check that a model has credentials. A configured provider without credentials opens its settings.
   * @returns whether a request can use the model.
   */
  ensureConfigured(model: string): boolean {
    if (this.remoteAgent) return true
    const provider = configuredProviders(this.settings.value).find((item) => model.startsWith(`${item.id}/`))
    if (!provider) return false
    try {
      providerCredentials(this.settings.value, provider.id)
      return true
    } catch {
      this.options.openProviderSettings(provider.id)
      return false
    }
  }

  /** Save provider settings, restore the previous ones if the connection rejects them, and drop unusable selections. */
  async saveSettings(next: LLMSettings): Promise<void> {
    const platform = this.platform
    await platform.settings.save(next)
    try {
      await this.connection?.settingsChanged?.(next)
    } catch (error) {
      await platform.settings.save(this.settings.value)
      throw error
    }
    this.settings.value = next
    if (!next[resolveModel(this.model.value).configuration]) this.model.value = FALLBACK_MODEL
    if (this.defaultModel.value && !next[resolveModel(this.defaultModel.value).configuration]) {
      this.defaultModel.value = ''
      this.options.storage?.removeItem(DEFAULT_MODEL_KEY)
    }
    if (this.titleModel.value && !next[resolveModel(this.titleModel.value).configuration]) {
      this.titleModel.value = ''
      this.options.storage?.removeItem(TITLE_MODEL_KEY)
    }
  }

  saveDefaultModel(value: string): void {
    this.selection.saveDefaultModel(value)
  }

  saveTitleModel(value: string): void {
    if (this.options.storage) this.titleModel.value = saveTitleModel(this.options.storage, value)
  }

  savePromptPresets(value: PromptPresetSettings): void {
    const storage = this.options.storage
    if (!storage) throw unavailable('Browser storage')
    const settings = parsePromptPresetSettings(value)
    storage.setItem(PROMPT_PRESETS_KEY, JSON.stringify(settings))
    this.promptPresets.value = settings
  }

  saveSubagentRoles(value: readonly SubagentRole[]): void {
    const storage = this.options.storage
    if (!storage) throw unavailable('Browser storage')
    const roles = parseSubagentRoles(value)
    if (roles.length) storage.setItem('keundal:subagent-roles', JSON.stringify(roles))
    else storage.removeItem('keundal:subagent-roles')
    this.subagentRoles.value = roles
  }

  /** Switch to the saved default model when the connection can serve it. */
  applyDefaultModel(): void {
    this.selection.applyDefaultModel()
  }

  async refreshModels(force = true): Promise<void> {
    await this.catalog?.refresh(force)
  }

  /** Skills and MCP tools that a prompt can name with `/`. */
  async promptCatalog(
    options?: ExecutionOptions
  ): Promise<{ skills: readonly SkillSummary[]; tools: readonly SkillSummary[] }> {
    return (await this.connection?.catalog?.(options)) ?? { skills: [], tools: [] }
  }

  /** Save MCP settings and restart the connection's tools. */
  async saveMcpSettings(value: unknown): Promise<void> {
    await this.platform.mcp.save(value, () => this.connection?.mcpChanged?.() ?? this.store.stop())
  }

  exportBackup(appearance: Pick<BackupPreferences, 'locale' | 'colorMode'>) {
    if (!this.options.storage) throw unavailable('Browser storage')
    return exportDataBackup({
      platform: this.platform,
      store: this.store,
      storage: this.options.storage,
      plugins: this.pluginManager,
      preferences: {
        ...appearance,
        webSearch: this.webSearch.value,
        reasoning: this.options.preferences.reasoning.value ?? 'medium'
      }
    })
  }

  async restoreBackup(value: unknown) {
    if (!this.options.storage) throw unavailable('Browser storage')
    const backup = parseDataBackup(value)
    const skipped = await restoreDataBackup(
      {
        platform: this.platform,
        store: this.store,
        storage: this.options.storage,
        plugins: this.pluginManager,
        settingsChanged: (next) => this.connection?.settingsChanged?.(next) ?? Promise.resolve()
      },
      backup
    )
    this.settings.value = backup.settings.providers
    this.promptPresets.value = backup.settings.promptPresets
    this.subagentRoles.value = backup.settings.subagentRoles
    this.defaultModel.value = backup.settings.models.default
    this.titleModel.value = backup.settings.models.title
    this.model.value = backup.settings.models.selected || backup.settings.models.default || FALLBACK_MODEL
    this.options.preferences.webSearch.value = backup.settings.preferences.webSearch
    this.options.preferences.reasoning.value = backup.settings.preferences.reasoning
    return skipped
  }

  /** Stop active responses before changing plugins. Safe before a browser connection exists. */
  async stopResponses(): Promise<void> {
    await this.connection?.store.stop()
  }

  /** Reload the conversation list. */
  async refreshChats(): Promise<void> {
    this.setPending('chats', true)
    try {
      this.chats.value = await listChatSummaries(this.store)
    } finally {
      this.setPending('chats', false)
    }
  }

  async renameChat(id: string, title: string): Promise<void> {
    await this.store.rename(id, title)
    this.chats.value = this.chats.value?.map((chat) => (chat.id === id ? { ...chat, title } : chat))
  }

  async deleteChat(id: string): Promise<void> {
    await this.store.delete(id)
    this.chats.value = this.chats.value?.filter((chat) => chat.id !== id)
  }

  private dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.scope.stop()
      this.unsubscribe?.()
      if (!this.options.platform) return
      try {
        await this.connection?.dispose()
      } finally {
        await this.options.platform.mcp.close()
      }
    })())
  }
}
