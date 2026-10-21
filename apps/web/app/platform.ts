import { McpManager, createBrowserMcpSettingsStorage } from '@keundal/plugin-chat-browser/mcp'
import { SkillManager } from '@keundal/plugin-chat-browser/skills'
import { BrowserAgentPluginManager } from '@keundal/plugin-chat-browser/plugins'
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
import { loadWebRuntimePlugins } from './runtime-plugins'

export function createWebPlatform(storage: Storage, runtime: { agentEndpoint?: string, agentToken?: string, pluginConfig?: string } = {}): ChatPlatform {
  const mcp = new McpManager(createBrowserMcpSettingsStorage(storage))
  const plugins = runtime.agentEndpoint ? undefined : new BrowserAgentPluginManager(storage)
  const platform: ChatPlatform = {
    mcp,
    plugins,
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
      const composition = await loadWebRuntimePlugins(runtime.pluginConfig, {
        'builtin:llm': { exports: { default: browserLLMPlugin }, config: { getSettings: options.getSettings, getModels: options.getModels } },
        'builtin:store': { exports: { default: indexedDBStorePlugin }, config: { databaseName: 'keundal-web' } },
        'builtin:skills': { exports: { default: skillPlugin }, config: { providers: [...options.skills, ...(plugins ? [plugins.provider] : [])] } },
        'builtin:agent': { exports: { default: agentPlugin }, config: { maxToolRounds: 4, subagents: true, parallelTools: true } },
        'builtin:chat-tools': { exports: { default: createChatTools } }
      }, async execution => [...await mcp.tools(execution), ...await plugins!.tools(execution)])
      const root = new Context()
      const scope = root.plugin(async (ctx: Context) => composition.setup(ctx))
      let store: ChatStore | undefined
      try {
        await scope
        for (const service of ['llm', 'session', 'generation'] as const) {
          if (!root[service]) throw new Error(`Missing browser service: ${service}`)
        }
        store = new ChatStore(root, (ctx, config) => composition.mountAgent(ctx, {
          model: config.model,
          maxOutputTokens: config.maxOutputTokens,
          reasoning: config.reasoning,
          webSearch: config.webSearch,
          skills: config.skills
        }))
        await store.recover()
        return {
          store,
          remoteAgent: false,
          catalog: async execution => ({
            skills: root.skills ? (await root.skills.prepare(execution)).skills : [],
            tools: (await composition.tools?.(execution ?? {}) ?? []).map(({ name, description }) => ({ name, description }))
          }),
          dispose: async () => {
            try {
              await store!.stop()
            } finally {
              await plugins?.close()
              await scope.dispose()
            }
          }
        }
      } catch (error) {
        try {
          await store?.stop()
        } finally {
          await plugins?.close()
          await scope.dispose()
        }
        throw error
      }
    }
  }
  return platform
}
