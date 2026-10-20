import { Context } from 'cordis'
import { useLocalStorage } from '@vueuse/core'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import skillPlugin from '@keundal/plugin-skill'
import { ChatStore, type ChatStoreLike } from '../../shared/utils/chat-store'
import { RemoteChatStore, type RemoteAgentInfo } from '../../shared/utils/remote-chat-store'
import type { ModelOption } from '../../shared/utils/models'
import { browserLLMPlugin } from '../../shared/utils/browser-llm'
import { defaultLLMSettings, type LLMSettings } from '../../shared/utils/llm-settings'
import { createLLMSettingsStorage, LLM_SETTINGS_KEY } from '../../shared/utils/llm-settings-storage'
import { SkillManager } from '../../shared/utils/skills'

export default defineNuxtPlugin(async () => {
  const { t } = useLocale()
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
    settings.value = next
  }
  const modelCatalog = useModelCatalog(settings)
  const skillManager = new SkillManager(localStorage, invokeNative)
  const runtime = useRuntimeConfig().public
  let remoteInfo: RemoteAgentInfo | undefined
  if (desktop && invokeNative) {
    try {
      remoteInfo = await invokeNative<RemoteAgentInfo>('sidecar_info')
    } catch {
      // Desktop keeps the browser-only mode when the local host cannot start.
    }
  } else if (runtime.agentEndpoint) {
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
      llmSettings: settings,
      saveLLMSettings,
      modelCatalog,
      skillManager
    }
  }
})
