import { Context } from 'cordis'
import { useLocalStorage } from '@vueuse/core'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import { ChatStore } from '../../shared/utils/chat-store'
import { browserLLMPlugin } from '../../shared/utils/browser-llm'
import { defaultLLMSettings } from '../../shared/utils/llm-settings'

export default defineNuxtPlugin(async () => {
  const ctx = new Context()
  const settings = useLocalStorage('keundal:llm-settings', defaultLLMSettings(), {
    writeDefaults: false,
    mergeDefaults: true
  })
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
  return { provide: { chatStore, llmSettings: settings, modelCatalog } }
})
