import { Context } from 'cordis'
import { useLocalStorage } from '@vueuse/core'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import { ChatStore } from '../../shared/utils/chat-store'
import { browserLLMPlugin } from '../../shared/utils/browser-llm'
import { defaultLLMSettings, type LLMSettings } from '../../shared/utils/llm-settings'
import { createLLMSettingsStorage, LLM_SETTINGS_KEY } from '../../shared/utils/llm-settings-storage'

export default defineNuxtPlugin(async () => {
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
      throw createError({ statusCode: 503, statusMessage: 'Secure storage unavailable', message: 'Could not load LLM settings. Unlock your OS secret store and restart the app. No browser storage fallback is used.' })
    }
  }
  async function saveLLMSettings(next: LLMSettings) {
    await storage.save(next)
    settings.value = next
  }
  const modelCatalog = useModelCatalog(settings)
  const llm = ctx.plugin(browserLLMPlugin, { getSettings: () => settings.value, getModels: () => modelCatalog.models.value })
  await llm
  const store = ctx.plugin(indexedDBStorePlugin, { databaseName: 'keundal-web' })
  await store
  const chatStore = new ChatStore(ctx)
  await chatStore.recover()
  if (import.meta.hot) import.meta.hot.dispose(async () => {
    await chatStore.stop()
    await store.dispose()
    await llm.dispose()
  })
  return { provide: { chatStore, llmSettings: settings, saveLLMSettings, modelCatalog } }
})
