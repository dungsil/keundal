import { McpManager, createBrowserMcpSettingsStorage } from '@keundal/plugin-chat-browser/mcp'
import { SkillManager } from '@keundal/plugin-chat-browser/skills'
import { Context } from 'cordis'
import agentPlugin from '@keundal/plugin-agent-chat'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import skillPlugin from '@keundal/plugin-skill'
import { ChatStore } from '@keundal/plugin-chat-local'
import { RemoteChatStore } from '@keundal/plugin-chat-remote'
import { browserLLMPlugin } from '@keundal/plugin-llm-browser'
import { loadModels } from '@keundal/plugin-llm-browser/models'
import { openaiTranscription } from '@keundal/plugin-transcription-browser'
import { createBrowserSettingsStorage } from '@keundal/plugin-chat-browser'
import { createChatTools } from '@keundal/plugin-tool-chat'
import type { ChatPlatform } from '@keundal/chat/platform'

export function createWebPlatform(storage: Storage, runtime: { agentEndpoint?: string, agentToken?: string } = {}): ChatPlatform {
  const mcp = new McpManager(createBrowserMcpSettingsStorage(storage))
  const platform: ChatPlatform = {
    mcp,
    settings: createBrowserSettingsStorage(storage),
    skills: new SkillManager(storage),
    loadModels,
    transcription: openaiTranscription,
    async connect(options) {
      if (runtime.agentEndpoint) {
        const store = new RemoteChatStore({ endpoint: runtime.agentEndpoint, token: runtime.agentToken ?? '' })
        try {
          await store.recover()
          return { store, remoteAgent: true, remoteModels: await store.models(), catalog: execution => store.catalog(execution), dispose: () => store.stop() }
        } catch (error) {
          await store.stop()
          throw error
        }
      }
      const root = new Context()
      const scope = root.plugin(async (ctx: Context) => {
        await ctx.plugin(browserLLMPlugin, { getSettings: options.getSettings, getModels: options.getModels })
        await ctx.plugin(indexedDBStorePlugin, { databaseName: 'keundal-web' })
        await ctx.plugin(skillPlugin, { providers: options.skills })
      })
      let store: ChatStore | undefined
      try {
        await scope
        store = new ChatStore(root, async (ctx, config) => ctx.plugin(agentPlugin, { ...config, tools: async execution => [...createChatTools(), ...await mcp.tools(execution)] }))
        await store.recover()
        return {
          store,
          remoteAgent: false,
          catalog: async execution => ({
            skills: (await root.skills.prepare(execution)).skills,
            tools: (await mcp.tools(execution)).map(({ name, description }) => ({ name, description }))
          }),
          dispose: async () => {
            try {
              await store!.stop()
            } finally {
              await scope.dispose()
            }
          }
        }
      } catch (error) {
        try {
          await store?.stop()
        } finally {
          await scope.dispose()
        }
        throw error
      }
    }
  }
  return platform
}
