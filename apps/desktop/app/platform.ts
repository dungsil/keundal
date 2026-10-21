import { McpManager } from '@keundal/plugin-chat-browser/mcp'
import { createDesktopChatStore } from '@keundal/plugin-chat-desktop'
import { createNativeSettingsStorage } from '@keundal/plugin-chat-desktop/settings'
import { createNativeSkillSource } from '@keundal/plugin-chat-desktop/skills'
import { loadModels } from '@keundal/plugin-llm-browser/models'
import { openaiTranscription } from '@keundal/plugin-transcription-browser'
import { resolveModel } from '@keundal/chat/models'
import { FALLBACK_MODEL } from '@keundal/chat/model-preferences'
import type { ChatPlatform, NativeInvoke } from '@keundal/chat/platform'

export function createDesktopPlatform(storage: Storage, invoke: NativeInvoke): ChatPlatform {
  const platform: ChatPlatform = {
    mcp: new McpManager(storage, invoke),
    settings: createNativeSettingsStorage(storage, invoke),
    skillFiles: createNativeSkillSource(invoke),
    loadModels,
    transcription: openaiTranscription,
    async connect(options) {
      const store = await createDesktopChatStore(invoke, options.getModels, options.initialModel)
      try {
        await store.recover()
        return {
          store,
          remoteAgent: true,
          selectedModel: store.selectedModel,
          selectModel: value => store.selectModel(value),
          mcpChanged: () => store.reloadSettings(),
          settingsChanged: async (next) => {
            if (!next[resolveModel(store.selectedModel).configuration]) await store.selectModel(FALLBACK_MODEL, true)
            else await store.reloadSettings()
          },
          dispose: () => store.stop()
        }
      } catch (error) {
        await store.stop()
        throw error
      }
    }
  }
  return platform
}
