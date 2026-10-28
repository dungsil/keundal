import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { createMemoryTools } from '@keundal/memory/tools'
import acpAgentPlugin from '@keundal/plugin-agent-acp'
import agentPlugin, { metadata as agentMetadata } from '@keundal/plugin-agent-chat'
import anthropic, { metadata as anthropicMetadata } from '@keundal/plugin-llm-anthropic'
import gemini, { metadata as geminiMetadata } from '@keundal/plugin-llm-gemini'
import openai, { metadata as openaiMetadata } from '@keundal/plugin-llm-openai'
import openaiChat, { metadata as openaiChatMetadata } from '@keundal/plugin-llm-openai-chat'
import { metadata as mcpMetadata } from '@keundal/plugin-mcp-client'
import { loadRuntimePlugins, parseRuntimePluginManifest, type RuntimePluginManifest } from '@keundal/plugin-runtime'
import skillPlugin, { metadata as skillMetadata } from '@keundal/plugin-skill'
import sqlite, { metadata as storeMetadata } from '@keundal/plugin-store-sqlite'
import { MemoryTaskService } from '@keundal/task-memory'
import type { ExecutableTool, ToolProvider } from '@keundal/tools'
import type { Context, Fiber } from 'cordis'
import { resolve as resolveModule } from 'import-meta-resolve'

import { createNodeAgentIntegrations } from './agent-integrations.js'
import { mountCodingAgent } from './coding-agent.js'
import type { HostCompositionFactory, NodeHostOptions } from './index.js'
import { NodeCodingWorkspaces } from './workspaces.js'

const providerPlugins = { openai, 'openai-chat': openaiChat, anthropic, gemini }

/** Display metadata for the statically bundled Node implementations, without loading external modules. */
export const nodePluginMetadata = {
  '@keundal/plugin-llm-openai': openaiMetadata,
  '@keundal/plugin-llm-openai-chat': openaiChatMetadata,
  '@keundal/plugin-llm-anthropic': anthropicMetadata,
  '@keundal/plugin-llm-gemini': geminiMetadata,
  '@keundal/plugin-store-sqlite': storeMetadata,
  '@keundal/plugin-agent-chat': agentMetadata,
  '@keundal/plugin-skill': skillMetadata,
  '@keundal/plugin-mcp-client': mcpMetadata,
  '@keundal/prompt': {
    name: { en: 'Prompt presets', ko: '프롬프트 프리셋' },
    description: {
      en: 'Applies reusable prompt presets to agent conversations.',
      ko: '에이전트 대화에 재사용 가능한 프롬프트 프리셋을 적용합니다.'
    }
  },
  '@keundal/subagent': {
    name: { en: 'Subagents', ko: '서브에이전트' },
    description: {
      en: 'Lets the agent delegate independent tasks to subagents.',
      ko: '에이전트가 독립 작업을 서브에이전트에 위임할 수 있게 합니다.'
    }
  }
}

interface LoadedNodePlugins {
  setup(ctx: Context): Promise<void>
  mountAgent(ctx: Context, config: Readonly<Record<string, unknown>>): Promise<Fiber>
  readonly tools?: ToolProvider
}

function defaultManifest(skills: boolean): RuntimePluginManifest {
  return {
    plugins: [
      { module: 'builtin:llm' },
      { module: 'builtin:store' },
      ...(skills ? [{ module: 'builtin:skills' }] : [])
    ],
    agent: { module: 'builtin:agent' }
  }
}

function readManifest(
  options: NodeHostOptions,
  skills: boolean
): { manifest: RuntimePluginManifest; basePath: string } {
  if (options.runtimePlugins) {
    return {
      manifest: parseRuntimePluginManifest(options.runtimePlugins),
      basePath: resolve(options.runtimePluginBasePath ?? process.cwd())
    }
  }

  const configuredPath = options.pluginConfigPath || undefined
  const discoveredPath =
    configuredPath ?? (existsSync(resolve('keundal.plugins.json')) ? 'keundal.plugins.json' : undefined)
  if (!discoveredPath) {
    return {
      manifest: defaultManifest(skills),
      basePath: resolve(options.runtimePluginBasePath ?? process.cwd())
    }
  }

  const manifestPath = resolve(discoveredPath)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`failed to read runtime plugin manifest at ${manifestPath}`, { cause: error })
  }
  return { manifest: parseRuntimePluginManifest(value), basePath: dirname(manifestPath) }
}

function createNodeImporter(basePath: string) {
  const parentURL = pathToFileURL(join(basePath, 'keundal.plugins.json')).href
  return async (specifier: string): Promise<Record<string, unknown>> => {
    let resolvedSpecifier: string
    if (specifier.startsWith('file:')) {
      resolvedSpecifier = specifier
    } else if (specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier)) {
      resolvedSpecifier = pathToFileURL(resolve(basePath, specifier)).href
    } else {
      resolvedSpecifier = resolveModule(specifier, parentURL)
    }
    // Plugin specifiers are selected at runtime, so static imports cannot preserve this contract.
    return (await import(/* @vite-ignore */ /* webpackIgnore: true */ resolvedSpecifier)) as Record<string, unknown>
  }
}

/** Configured deployment modules, including optional modules, without importing them. */
export function getConfiguredNodePluginModules(options: NodeHostOptions): string[] {
  const { manifest } = readManifest(options, true)
  const llm = manifest.plugins.find((spec) => spec.module === 'builtin:llm')
  const provider =
    llm?.export && Object.hasOwn(providerPlugins, llm.export)
      ? llm.export
      : String(llm?.config?.provider ?? options.provider)
  const builtinNames: Record<string, string> = {
    'builtin:llm': `@keundal/plugin-llm-${provider}`,
    'builtin:store': '@keundal/plugin-store-sqlite',
    'builtin:acp': '@keundal/plugin-agent-acp',
    'builtin:agent': '@keundal/plugin-agent-chat'
  }
  return [
    ...new Set(
      [...manifest.plugins, manifest.agent, ...(manifest.tools ?? [])]
        .filter((spec) => !['builtin:skills', '@keundal/plugin-skill'].includes(spec.module))
        .map((spec) => builtinNames[spec.module] ?? spec.module)
    )
  ]
}

/** Only the LLM and persistence implementations are protected from selection changes. */
export function getRequiredNodePluginModules(options: NodeHostOptions): string[] {
  return getConfiguredNodePluginModules(options).filter(
    (module) => module.startsWith('@keundal/plugin-llm-') || module.startsWith('@keundal/plugin-store-')
  )
}

export const createNodeComposition: HostCompositionFactory = (options) => {
  const workspaceRoot = resolve(
    options.workspaceRoot ??
      join(homedir(), '.keundal', 'workspaces', createHash('sha256').update(resolve(options.sqlitePath)).digest('hex'))
  )
  const workspaces = new NodeCodingWorkspaces(workspaceRoot)
  const promptPresetsEnabled = options.bundledPlugins?.['@keundal/prompt'] !== false
  const subagentsEnabled = options.bundledPlugins?.['@keundal/subagent'] !== false
  const skillsEnabled = options.bundledPlugins?.['@keundal/plugin-skill'] !== false
  const mcpEnabled = options.bundledPlugins?.['@keundal/plugin-mcp-client'] !== false
  const integrations = createNodeAgentIntegrations(options, mcpEnabled)
  const { plugins, skillProviders } = integrations
  const legacyToolsEnabled = options.bundledPlugins?.['@keundal/plugin-tool-chat'] ?? true
  const chartEnabled = options.bundledPlugins?.['@keundal/plugin-tool-chart'] ?? legacyToolsEnabled
  const weatherEnabled = options.bundledPlugins?.['@keundal/plugin-tool-weather'] ?? legacyToolsEnabled
  const selection = readManifest(options, skillsEnabled && Boolean(options.plugins?.length))
  const agentEnabled =
    options.bundledPlugins?.['@keundal/plugin-agent-chat'] !== false &&
    options.bundledPlugins?.[selection.manifest.agent.module] !== false
  const required = new Set(getRequiredNodePluginModules(options))
  const manifest: RuntimePluginManifest = {
    ...selection.manifest,
    ...(!agentEnabled ? { agent: { module: 'builtin:agent' } } : {}),
    plugins: selection.manifest.plugins.filter(
      (spec) =>
        (skillsEnabled || !['builtin:skills', '@keundal/plugin-skill'].includes(spec.module)) &&
        (spec.module === 'builtin:llm' ||
          spec.module === 'builtin:store' ||
          required.has(spec.module) ||
          options.bundledPlugins?.[spec.module] !== false)
    ),
    ...(selection.manifest.tools === undefined
      ? {}
      : {
          tools: selection.manifest.tools.flatMap((spec) => {
            if (options.bundledPlugins?.[spec.module] === false && spec.module !== '@keundal/plugin-tool-chat')
              return []
            if (spec.module === '@keundal/plugin-tool-chat') {
              return [
                ...(chartEnabled
                  ? [
                      {
                        ...spec,
                        module: '@keundal/plugin-tool-chart',
                        export: spec.export === 'createChatTools' ? 'createChartTools' : spec.export
                      }
                    ]
                  : []),
                ...(weatherEnabled
                  ? [
                      {
                        ...spec,
                        module: '@keundal/plugin-tool-weather',
                        export: spec.export === 'createChatTools' ? 'createWeatherTools' : spec.export
                      }
                    ]
                  : [])
              ]
            }
            if (
              (!chartEnabled && spec.module === '@keundal/plugin-tool-chart') ||
              (!weatherEnabled && spec.module === '@keundal/plugin-tool-weather')
            )
              return []
            return [spec]
          })
        })
  }
  const basePath = selection.basePath
  const builtinLlmSpec = manifest.plugins.find((spec) => spec.module === 'builtin:llm')
  const hasBuiltinLlm = Boolean(builtinLlmSpec)
  const builtinLlmProvider = String(builtinLlmSpec?.config?.provider ?? options.provider)
  const builtinRegistry = {
    'builtin:llm': {
      config: {
        provider: options.provider,
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        headers: options.headers,
        models: options.models ?? { [options.model]: { contextWindow: 128000, maxOutputTokens: 4096 } }
      },
      exports: {
        default: providerPlugins[builtinLlmProvider as keyof typeof providerPlugins],
        ...providerPlugins
      }
    },
    'builtin:store': { config: { path: options.sqlitePath }, exports: { default: sqlite } },
    'builtin:skills': {
      config: { providers: skillProviders },
      exports: { default: skillPlugin }
    },
    'builtin:acp': { exports: { default: acpAgentPlugin } },
    'builtin:agent': {
      config: {
        maxToolRounds: options.maxToolRounds ?? 4,
        skills: skillsEnabled && Boolean(options.plugins?.length),
        subagents: options.subagents ?? true,
        maxActiveSubagents: options.maxActiveSubagents,
        parallelTools: true
      },
      exports: { default: agentPlugin }
    }
  }
  const defaultTools = manifest.tools === undefined ? options.defaultTools : undefined
  let memoryTools: readonly ExecutableTool[] = []
  const suppliedTools: ToolProvider | undefined =
    defaultTools || options.tools || options.projectId !== undefined
      ? async (execution) => [
          ...(typeof defaultTools === 'function' ? await defaultTools(execution) : (defaultTools ?? [])).filter(
            (tool) => (chartEnabled || tool.name !== 'chart') && (weatherEnabled || tool.name !== 'weather')
          ),
          ...(typeof options.tools === 'function' ? await options.tools(execution) : (options.tools ?? [])),
          ...memoryTools
        ]
      : undefined
  let runtime: LoadedNodePlugins | undefined
  let runtimePromise: Promise<LoadedNodePlugins> | undefined

  return {
    plugins,
    workspaces,
    toolCatalog: async (execution) =>
      (await runtime?.tools?.(execution))?.map(({ name, description }) => ({ name, description })) ?? [],
    async setup(ctx) {
      workspaces.setup(ctx)
      await integrations.setup(ctx)
      if (skillsEnabled && plugins.length && !manifest.plugins.some((spec) => spec.module === 'builtin:skills')) {
        throw new Error('runtime plugin manifest must include builtin:skills when Agent Plugins are configured')
      }
      if (hasBuiltinLlm && !providerPlugins[builtinLlmProvider as keyof typeof providerPlugins]) {
        throw new Error(`unsupported KEUNDAL_PROVIDER for builtin:llm: ${builtinLlmProvider}`)
      }
      if (hasBuiltinLlm && options.requireProviderApiKey && !options.apiKey.trim()) {
        throw new Error('OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY 중 하나를 설정하세요.')
      }
      if (manifest.plugins.some((spec) => spec.module === 'builtin:store')) {
        const store = manifest.plugins.find((spec) => spec.module === 'builtin:store')!
        const path = String(store.config?.path ?? options.sqlitePath)
        if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
      }
      runtimePromise ??= loadRuntimePlugins(manifest, {
        importModule: createNodeImporter(basePath),
        builtins: builtinRegistry,
        tools: suppliedTools,
        deferredToolProvider: integrations.tools
      })
      runtime = await runtimePromise
      await runtime.setup(ctx)
      if (options.projectId !== undefined) {
        const memory = ctx.get('memory')
        if (!memory) throw new Error('project memory requires a memory service')
        memoryTools = createMemoryTools(memory, options.projectId)
      }
      const tasks = new MemoryTaskService(ctx, {
        maxActive: options.maxActiveSubagents ?? 8,
        store: ctx.get('taskStore')
      })
      // Finish recovery before exposing the host, even when no task is enqueued.
      await tasks.list()
    },
    async mountAgent(ctx, config) {
      if (!agentEnabled) throw new Error('Agent is disabled; enable the agent plugin to generate responses')
      if (!runtime) throw new Error('runtime plugins are not initialized')
      if (manifest.agent.module === 'builtin:acp' || manifest.agent.module === '@keundal/plugin-agent-acp') {
        return runtime.mountAgent(ctx, {
          ...config,
          toolApproval: options.toolApproval === undefined ? undefined : config.toolApproval,
          ...(config.workspacePath ? { cwd: config.workspacePath } : {})
        })
      }
      if (config.codingThreadId && config.workspacePath) {
        return mountCodingAgent(ctx, config, options)
      }
      return runtime.mountAgent(ctx, {
        ...config,
        ...(!skillsEnabled ? { skills: false } : {}),
        ...(!promptPresetsEnabled ? { promptPresets: false } : {}),
        ...(!subagentsEnabled ? { subagents: false } : {}),
        reasoning:
          hasBuiltinLlm &&
          (builtinLlmProvider === 'openai' || builtinLlmProvider === 'openai-chat') &&
          !/^(gpt-5|o\d)(?:[-.]|$)/.test(config.model)
            ? undefined
            : config.reasoning
      })
    }
  }
}
