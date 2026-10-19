import type { invoke } from '@tauri-apps/api/core'
import { defaultLLMSettings, llmSettingsSchema, type LLMSettings } from './llm-settings'

export const LLM_SETTINGS_KEY = 'keundal:llm-settings'

export function createLLMSettingsStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, invokeNative?: typeof invoke) {
  async function save(settings: LLMSettings) {
    const next = llmSettingsSchema.parse(settings)
    if (invokeNative) {
      const empty = Object.values(next).every(provider => !provider.apiKey && !provider.baseURL && !Object.keys(provider.headers ?? {}).length)
      await invokeNative('save_llm_settings', { settings: empty ? null : JSON.stringify(next) })
      // Never remove the legacy copy until native persistence succeeds.
      storage.removeItem(LLM_SETTINGS_KEY)
    } else {
      storage.setItem(LLM_SETTINGS_KEY, JSON.stringify(next))
    }
  }

  async function load(): Promise<LLMSettings> {
    if (invokeNative) {
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
    if (invokeNative) await save(settings)
    return settings
  }

  return { load, save }
}
