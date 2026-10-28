import { McpManager, createBrowserMcpSettingsStorage } from '@keundal/plugin-chat-browser/mcp'
import { SkillManager } from '@keundal/plugin-chat-browser/skills'
import { BrowserAgentPluginManager } from '@keundal/plugin-chat-browser/plugins'
import { Context, type Fiber } from 'cordis'
import agentPlugin, { metadata as agentMetadata } from '@keundal/plugin-agent-chat'
import indexedDBStorePlugin, { metadata as storeMetadata } from '@keundal/plugin-store-indexeddb'
import skillPlugin, { metadata as skillMetadata } from '@keundal/plugin-skill'
import { ChatStore } from '@keundal/plugin-chat-local'
import { RemoteChatStore } from '@keundal/plugin-chat-remote'
import { browserLLMPlugin, metadata as llmMetadata } from '@keundal/plugin-llm-browser'
import { loadModels } from '@keundal/plugin-llm-browser/models'
import { openaiTranscription } from '@keundal/plugin-transcription-browser'
import { BrowserRuntimePluginManager, createBrowserSettingsStorage } from '@keundal/plugin-chat-browser'
import { mountRuntimePlugin, type RuntimeModuleRegistry } from '@keundal/plugin-runtime'
import { createChartTools, metadata as chartMetadata } from '@keundal/plugin-tool-chart'
import { createWeatherTools, metadata as weatherMetadata } from '@keundal/plugin-tool-weather'
import type { ChatPlatform } from '@keundal/chat/platform'
import { loadWebRuntimePlugins } from './runtime-plugins'
import { metadata as mcpMetadata } from '@keundal/plugin-chat-browser/mcp'
import { MemoryTaskService } from '@keundal/task-memory'

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
          return { store, workspaces: store.workspaces, tasks: store.tasks, remoteAgent: true, remoteModels: await store.models(), catalog: execution => store.catalog(execution), dispose: () => store.stop() }
        } catch (error) {
          await store.stop()
          throw error
        }
      }
      let manager: BrowserRuntimePluginManager
      const chartTools = () => manager.isEnabled('@keundal/plugin-tool-chart') ? createChartTools() : []
      const weatherTools = () => manager.isEnabled('@keundal/plugin-tool-weather') ? createWeatherTools() : []
      const builtins: RuntimeModuleRegistry = {
        'builtin:llm': { exports: { default: browserLLMPlugin }, config: { getSettings: options.getSettings, getModels: options.getModels } },
        'builtin:store': { exports: { default: indexedDBStorePlugin }, config: { databaseName: 'keundal-web' } },
        'builtin:skills': { exports: { default: skillPlugin }, config: { providers: [...options.skills, ...(plugins ? [plugins.provider] : [])] } },
        'builtin:agent': { exports: { default: agentPlugin }, config: { maxToolRounds: 4, subagents: true, parallelTools: true } },
        'builtin:chart': { exports: { default: chartTools } },
        'builtin:weather': { exports: { default: weatherTools } },
        'builtin:chat-tools': { exports: { default: () => [...chartTools(), ...weatherTools()] } }
      }
      const composition = await loadWebRuntimePlugins(runtime.pluginConfig, builtins, undefined,
        async execution => manager.isEnabled('@keundal/plugin-mcp-client')
          ? [...await mcp.tools(execution), ...await plugins!.tools(execution)] : [])
      const root = new Context()
      let store: ChatStore | undefined
      let skillFiber: Fiber | undefined
      let connected = false
      const selectSkills = async (enabled: boolean) => {
        if (!enabled) {
          await skillFiber?.dispose()
          skillFiber = undefined
        } else if (!skillFiber) {
          skillFiber = await mountRuntimePlugin(root, composition.skills ?? { module: 'builtin:skills' }, {
            builtins,
            importModule: async () => { throw new Error('Only bundled plugins are selectable') }
          })
        }
      }
      const saved: unknown = JSON.parse(storage.getItem('keundal:bundled-plugins') ?? '{}')
      if (saved && typeof saved === 'object' && '@keundal/plugin-tool-chat' in saved && typeof saved['@keundal/plugin-tool-chat'] === 'boolean') {
        const selection = saved as Record<string, unknown>
        storage.setItem('keundal:bundled-plugins', JSON.stringify({
          ...selection,
          '@keundal/plugin-tool-chart': typeof selection['@keundal/plugin-tool-chart'] === 'boolean' ? selection['@keundal/plugin-tool-chart'] : selection['@keundal/plugin-tool-chat'],
          '@keundal/plugin-tool-weather': typeof selection['@keundal/plugin-tool-weather'] === 'boolean' ? selection['@keundal/plugin-tool-weather'] : selection['@keundal/plugin-tool-chat']
        }))
      }
      manager = new BrowserRuntimePluginManager(storage, [
        { module: '@keundal/plugin-llm-browser', metadata: llmMetadata, enabled: true, required: true },
        { module: '@keundal/plugin-store-indexeddb', metadata: storeMetadata, enabled: true, required: true },
        { module: '@keundal/plugin-agent-chat', metadata: agentMetadata, enabled: true, feature: 'agent', requires: ['@keundal/plugin-llm-browser', '@keundal/plugin-store-indexeddb'] },
        { module: '@keundal/prompt', metadata: { name: { en: 'Prompt presets', ko: '프롬프트 프리셋' }, description: { en: 'Applies the selected prompt recipe to model requests.', ko: '선택한 프롬프트 프리셋을 모델 요청에 적용합니다.' } }, enabled: true, feature: 'prompt', requires: ['@keundal/plugin-agent-chat'] },
        { module: '@keundal/subagent', metadata: { name: { en: 'Subagents', ko: '서브에이전트' }, description: { en: 'Delegates independent tasks to subagents.', ko: '독립 작업을 서브에이전트에 위임합니다.' } }, enabled: true, feature: 'subagents', requires: ['@keundal/plugin-agent-chat'] },
        { module: '@keundal/plugin-skill', metadata: skillMetadata, enabled: !!composition.skills, feature: 'skills' },
        { module: '@keundal/plugin-tool-chart', metadata: chartMetadata, enabled: true },
        { module: '@keundal/plugin-tool-weather', metadata: weatherMetadata, enabled: true },
        { module: '@keundal/plugin-mcp-client', metadata: mcpMetadata, enabled: true, feature: 'mcp' }
      ], async (module, enabled) => {
        if (!connected) throw new Error('The browser plugin runtime is not connected')
        await store!.stop()
        if (module === '@keundal/plugin-skill') await selectSkills(enabled)
        if (module === '@keundal/plugin-mcp-client' && !enabled) {
          await mcp.close()
          await plugins?.close()
        }
      })
      const scope = root.plugin(async (ctx: Context) => {
        new MemoryTaskService(ctx)
        await selectSkills(manager.isEnabled('@keundal/plugin-skill'))
        await composition.setup(ctx)
      })
      try {
        await scope
        for (const service of ['llm', 'session', 'generation'] as const) {
          if (!root[service]) throw new Error(`Missing browser service: ${service}`)
        }
        store = new ChatStore(root, (ctx, config) => {
          if (!manager.isEnabled('@keundal/plugin-agent-chat')) throw new Error('Chat agent is disabled. Enable it in plugin settings to generate responses.')
          return composition.mountAgent(ctx, {
            model: config.model,
            toolApproval: config.toolApproval,
            maxOutputTokens: config.maxOutputTokens,
            reasoning: config.reasoning,
            webSearch: config.webSearch,
            skills: manager.isEnabled('@keundal/plugin-skill') && config.skills,
            ...(!manager.isEnabled('@keundal/prompt') ? { promptPresets: false } : {}),
            ...(!manager.isEnabled('@keundal/subagent') ? { subagents: false } : {})
          })
        })
        await store.recover()
        connected = true
        platform.runtimePlugins = manager
        return {
          store,
          tasks: root.tasks,
          remoteAgent: false,
          catalog: async execution => ({
            skills: root.skills ? (await root.skills.prepare(execution)).skills : [],
            tools: (await composition.tools?.(execution ?? {}) ?? []).map(({ name, description }) => ({ name, description }))
          }),
          dispose: async () => {
            connected = false
            try {
              await root.tasks.dispose()
              await store!.stop()
            } finally {
              await skillFiber?.dispose()
              await plugins?.close()
              await scope.dispose()
            }
          }
        }
      } catch (error) {
        try {
          await store?.stop()
        } finally {
          await skillFiber?.dispose()
          await plugins?.close()
          await scope.dispose()
        }
        throw error
      }
    }
  }
  return platform
}
