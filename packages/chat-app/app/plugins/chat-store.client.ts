import { useLocalStorage } from '@vueuse/core'
import type { ChatPlatform, ChatConnection } from '@keundal/chat/platform'
import { resolveModel } from '@keundal/chat/models'
import { FALLBACK_MODEL, type LLMSettings } from '@keundal/llm-settings'
import { MODEL_KEY, DEFAULT_MODEL_KEY, TITLE_MODEL_KEY, readModelPreference, loadModelPreferences } from '@keundal/chat/model-preferences'

declare module '#app' {
  interface NuxtApp { $chatPlatform: ChatPlatform }
}

export default defineNuxtPlugin({
  name: 'chat-store',
  enforce: 'post',
  async setup(app) {
    const platform: ChatPlatform = app.$chatPlatform
    if (!platform) throw new Error('The application must provide a chat-platform plugin')
    const mcpManager = platform.mcp
    await mcpManager.load()
    const { t } = useLocale()
    const preferences = loadModelPreferences(localStorage)
    const defaultModel = useState('default-model', () => '')
    defaultModel.value = preferences.defaultModel
    const titleModel = useState('title-model', () => '')
    titleModel.value = readModelPreference(localStorage, TITLE_MODEL_KEY) ?? ''
    const initialModel = preferences.model
    const model = useState('chat-model', () => FALLBACK_MODEL)
    useLocalStorage(MODEL_KEY, model, { writeDefaults: false })
    model.value = initialModel || FALLBACK_MODEL
    let loaded: LLMSettings
    try {
      loaded = await platform.settings.load()
    } catch (error) {
      if (useRuntimeConfig().public.chatCapabilities.secureSettings) {
        throw createError({ statusCode: 503, statusMessage: t('error.secureStorage'), message: t('error.secureStorageDescription'), cause: error })
      }
      throw error
    }
    const settings = ref(loaded)
    const modelCatalog = useModelCatalog(settings, platform.loadModels, () => t('model.loadFailed'))
    const skillManager = platform.skills
    const connection: ChatConnection = await platform.connect({
      getSettings: () => settings.value,
      getModels: () => modelCatalog.models.value,
      initialModel: initialModel && settings.value[resolveModel(initialModel).configuration] ? initialModel : undefined,
      skills: skillManager.providers
    })
    if (connection.selectedModel) model.value = connection.selectedModel
    const unsubscribe = platform.settings.subscribe?.((value) => {
      settings.value = value
    })
    let disposal: Promise<void> | undefined
    const dispose = () => disposal ??= (async () => {
      unsubscribe?.()
      try {
        await connection.dispose()
      } finally {
        await mcpManager.close()
      }
    })()
    app.vueApp.onUnmount(() => {
      void dispose()
    })
    if (import.meta.hot) import.meta.hot.dispose(dispose)

    async function saveMcpSettings(value: unknown) {
      await mcpManager.save(value, () => connection.mcpChanged?.() ?? connection.store.stop())
    }
    async function saveLLMSettings(next: LLMSettings) {
      await platform.settings.save(next)
      try {
        await connection.settingsChanged?.(next)
      } catch (error) {
        await platform.settings.save(settings.value)
        throw error
      }
      settings.value = next
      if (!next[resolveModel(model.value).configuration]) model.value = FALLBACK_MODEL
      if (defaultModel.value && !next[resolveModel(defaultModel.value).configuration]) {
        defaultModel.value = ''
        localStorage.removeItem(DEFAULT_MODEL_KEY)
      }
      if (titleModel.value && !next[resolveModel(titleModel.value).configuration]) {
        titleModel.value = ''
        localStorage.removeItem(TITLE_MODEL_KEY)
      }
    }
    return {
      provide: {
        chatStore: connection.store,
        remoteAgent: connection.remoteAgent,
        remoteModels: connection.remoteModels ? ref(connection.remoteModels) : undefined,
        selectModel: connection.selectModel,
        llmSettings: settings,
        saveLLMSettings,
        modelCatalog,
        skillManager,
        mcpManager,
        saveMcpSettings
      }
    }
  }
})
