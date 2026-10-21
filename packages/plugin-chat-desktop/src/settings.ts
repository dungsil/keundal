import { defaultLLMSettings, llmSettingsSchema, type LLMSettings } from '@keundal/chat/llm-settings'
import type { NativeInvoke, SettingsStorage } from '@keundal/chat/platform'
import { LLM_SETTINGS_KEY } from '@keundal/chat/platform'

export function createNativeSettingsStorage(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  invokeNative: NativeInvoke
): SettingsStorage {
  async function save(settings: LLMSettings) {
    const next = llmSettingsSchema.parse(settings)
    {
      const empty = Object.values(next).every(
        (provider) =>
          !provider.name && !provider.apiKey && !provider.baseURL && !Object.keys(provider.headers ?? {}).length
      )
      await invokeNative('save_llm_settings', { settings: empty ? null : JSON.stringify(next) })
      // Never remove the legacy copy until native persistence succeeds.
      storage.removeItem(LLM_SETTINGS_KEY)
    }
  }

  async function load(): Promise<LLMSettings> {
    {
      const saved = await invokeNative<string | null>('load_llm_settings')
      if (saved !== null) {
        const settings = llmSettingsSchema.parse(JSON.parse(saved))
        storage.removeItem(LLM_SETTINGS_KEY)
        return settings
      }
    }
    const legacy = storage.getItem(LLM_SETTINGS_KEY)
    if (legacy === null) return defaultLLMSettings()
    const settings = llmSettingsSchema.parse(JSON.parse(legacy))
    await save(settings)
    return settings
  }

  return { load, save }
}
