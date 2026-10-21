import { defaultLLMSettings, llmSettingsSchema } from '@keundal/chat/llm-settings'
import { LLM_SETTINGS_KEY, type SettingsStorage } from '@keundal/chat/platform'

export function createBrowserSettingsStorage(storage: Pick<Storage, 'getItem' | 'setItem'>): SettingsStorage {
  const load = () => {
    const value = storage.getItem(LLM_SETTINGS_KEY)
    return value === null ? defaultLLMSettings() : llmSettingsSchema.parse(JSON.parse(value))
  }
  return {
    load: async () => load(),
    save: async (settings) => {
      storage.setItem(LLM_SETTINGS_KEY, JSON.stringify(llmSettingsSchema.parse(settings)))
    },
    subscribe(listener) {
      const change = (event: StorageEvent) => {
        if (event.storageArea !== storage || (event.key !== null && event.key !== LLM_SETTINGS_KEY)) return
        listener(load())
      }
      window.addEventListener('storage', change)
      return () => window.removeEventListener('storage', change)
    }
  }
}
