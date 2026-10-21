import { Context } from 'cordis'
import { useLocalStorage } from '@vueuse/core'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import skillPlugin from '@keundal/plugin-skill'
import { ChatStore, type ChatStoreLike } from '../../shared/utils/chat-store'
import { RemoteChatStore, type RemoteAgentInfo } from '../../shared/utils/remote-chat-store'
import { createDesktopChatStore } from '../../shared/utils/desktop-chat-store'
import { resolveModel, type ModelOption } from '../../shared/utils/models'
import { browserLLMPlugin } from '../../shared/utils/browser-llm'
import { defaultLLMSettings, type LLMSettings } from '../../shared/utils/llm-settings'
import { createLLMSettingsStorage, LLM_SETTINGS_KEY } from '../../shared/utils/llm-settings-storage'
import { SkillManager } from '../../shared/utils/skills'
import { FALLBACK_MODEL, MODEL_KEY, DEFAULT_MODEL_KEY, loadModelPreferences } from '../../shared/utils/model-preferences'

export default defineNuxtPlugin(async () => {
  const { t } = useLocale()
  const preferences = loadModelPreferences(localStorage)
  const defaultModel = useState('default-model', () => '')
  defaultModel.value = preferences.defaultModel
  const initialModel = preferences.model
  const model = useState('chat-model', () => FALLBACK_MODEL)
  useLocalStorage(MODEL_KEY, model, { writeDefaults: false })
  model.value = initialModel || FALLBACK_MODEL
  const ctx = new Context()
  const desktop = useRuntimeConfig().public.desktop
  const invokeNative = desktop ? (await import('@tauri-apps/api/core')).invoke : undefined
  const storage = createLLMSettingsStorage(localStorage, invokeNative)
  // Desktop must never bind credentials to a localStorage-backed ref.
  const settings = desktop
    ? ref(defaultLLMSettings())
    : useLocalStorage(LLM_SETTINGS_KEY, defaultLLMSettings(), { writeDefaults: false, mergeDefaults: true })
  if (desktop) {
    try {
      settings.value = await storage.load()
    } catch {
      throw createError({ statusCode: 503, statusMessage: t('error.secureStorage'), message: t('error.secureStorageDescription') })
    }
  }
  async function saveLLMSettings(next: LLMSettings) {
    await storage.save(next)
    if (desktopStore) {
      try {
        if (!next[resolveModel(desktopStore.selectedModel).configuration]) {
          await desktopStore.selectModel(FALLBACK_MODEL, true)
        } else {
          await desktopStore.reloadSettings()
        }
      } catch (error) {
        await storage.save(settings.value)
        throw error
      }
    }
    settings.value = next
    if (!next[resolveModel(model.value).configuration]) model.value = FALLBACK_MODEL
    if (defaultModel.value && !next[resolveModel(defaultModel.value).configuration]) {
      defaultModel.value = ''
      localStorage.removeItem(DEFAULT_MODEL_KEY)
    }
  }
  const modelCatalog = useModelCatalog(settings, () => t('model.loadFailed'))
  const skillManager = new SkillManager(localStorage, invokeNative)
  const runtime = useRuntimeConfig().public
  let desktopStore: Awaited<ReturnType<typeof createDesktopChatStore>> | undefined
  const selectModel = desktop && invokeNative ? (value: string) => desktopStore!.selectModel(value) : undefined
  if (desktop && invokeNative) {
    desktopStore = await createDesktopChatStore(invokeNative, () => modelCatalog.models.value, initialModel && settings.value[resolveModel(initialModel).configuration] ? initialModel : undefined)
    model.value = desktopStore.selectedModel
    await desktopStore.recover()
    if (import.meta.hot) import.meta.hot.dispose(() => desktopStore!.stop())
    return {
      provide: {
        chatStore: desktopStore as ChatStoreLike,
        remoteAgent: true,
        remoteModels: undefined as Ref<ModelOption[]> | undefined,
        selectModel,
        llmSettings: settings,
        saveLLMSettings,
        modelCatalog,
        skillManager
      }
    }
  }
  let remoteInfo: RemoteAgentInfo | undefined
  if (runtime.agentEndpoint) {
    remoteInfo = { endpoint: runtime.agentEndpoint, token: runtime.agentToken ?? '' }
  }

  let remoteModels: Ref<ModelOption[]> | undefined
  let chatStore: ChatStoreLike
  if (remoteInfo) {
    const remote = new RemoteChatStore(remoteInfo)
    await remote.recover()
    remoteModels = ref(await remote.models())
    chatStore = remote
    if (import.meta.hot) import.meta.hot.dispose(async () => {
      await remote.stop()
    })
    return {
      provide: {
        chatStore,
        remoteAgent: true,
        remoteModels,
        selectModel,
        llmSettings: settings,
        saveLLMSettings,
        modelCatalog,
        skillManager
      }
    }
  }

  const llm = ctx.plugin(browserLLMPlugin, { getSettings: () => settings.value, getModels: () => modelCatalog.models.value })
  await llm
  const store = ctx.plugin(indexedDBStorePlugin, { databaseName: 'keundal-web' })
  await store
  const skills = await ctx.plugin(skillPlugin, { providers: skillManager.providers })
  const local = new ChatStore(ctx)
  chatStore = local
  await local.recover()
  if (import.meta.hot) import.meta.hot.dispose(async () => {
    await local.stop()
    await skills.dispose()
    await store.dispose()
    await llm.dispose()
  })
  return {
    provide: {
      chatStore,
      remoteAgent: false,
      remoteModels,
      selectModel,
      llmSettings: settings,
      saveLLMSettings,
      modelCatalog,
      skillManager
    }
  }
})
