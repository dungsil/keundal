import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { loadAgentPlugin, type LoadedAgentPlugin } from '@keundal/agent-plugins'
import type { ExecutionOptions } from '@keundal/core'
import { parseMcpServers } from '@keundal/mcp'
import agentPlugin, { metadata as agentMetadata } from '@keundal/plugin-agent-chat'
import codingAgentPlugin from '@keundal/plugin-agent-coding'
import { LocalFileSystemService } from '@keundal/plugin-fs-local'
import { PolicyFileSystemService } from '@keundal/plugin-fs-policy'
import anthropic, { metadata as anthropicMetadata } from '@keundal/plugin-llm-anthropic'
import gemini, { metadata as geminiMetadata } from '@keundal/plugin-llm-gemini'
import openai, { metadata as openaiMetadata } from '@keundal/plugin-llm-openai'
import openaiChat, { metadata as openaiChatMetadata } from '@keundal/plugin-llm-openai-chat'
import { McpClient, metadata as mcpMetadata } from '@keundal/plugin-mcp-client'
import { loadRuntimePlugins, parseRuntimePluginManifest, type RuntimePluginManifest } from '@keundal/plugin-runtime'
import skillPlugin, { metadata as skillMetadata } from '@keundal/plugin-skill'
import sqlite, { metadata as storeMetadata } from '@keundal/plugin-store-sqlite'
import { FileSystemToolsService } from '@keundal/plugin-tool-fs'
import type { SkillProvider } from '@keundal/skill'
import { MemoryTaskService } from '@keundal/task-memory'
import type { ExecutableTool, ToolProvider } from '@keundal/tools'
import type { Context, Fiber } from 'cordis'
import { resolve as resolveModule } from 'import-meta-resolve'

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
  const plugins: LoadedAgentPlugin[] = []
  const skillProviders: SkillProvider[] = []
  const promptPresetsEnabled = options.bundledPlugins?.['@keundal/prompt'] !== false
  const subagentsEnabled = options.bundledPlugins?.['@keundal/subagent'] !== false
  const skillsEnabled = options.bundledPlugins?.['@keundal/plugin-skill'] !== false
  const mcpEnabled = options.bundledPlugins?.['@keundal/plugin-mcp-client'] !== false
  const legacyToolsEnabled = options.bundledPlugins?.['@keundal/plugin-tool-chat'] ?? true
  const chartEnabled = options.bundledPlugins?.['@keundal/plugin-tool-chart'] ?? legacyToolsEnabled
  const weatherEnabled = options.bundledPlugins?.['@keundal/plugin-tool-weather'] ?? legacyToolsEnabled
  const mcpServers = mcpEnabled ? parseMcpServers(options.mcpServers ?? []) : []
  const mcpClients = new Map<string, Promise<McpClient>>()
  const mcpLifetime = new globalThis.AbortController()
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
  const suppliedTools: ToolProvider | undefined =
    defaultTools || options.tools
      ? async (execution) => [
          ...(typeof defaultTools === 'function' ? await defaultTools(execution) : (defaultTools ?? [])).filter(
            (tool) => (chartEnabled || tool.name !== 'chart') && (weatherEnabled || tool.name !== 'weather')
          ),
          ...(typeof options.tools === 'function' ? await options.tools(execution) : (options.tools ?? []))
        ]
      : undefined
  const deferredToolProvider: ToolProvider = async (execution: ExecutionOptions) => {
    const signal = execution.signal
      ? globalThis.AbortSignal.any([execution.signal, mcpLifetime.signal])
      : mcpLifetime.signal
    const result: ExecutableTool[] = []
    for (const server of mcpServers) {
      signal.throwIfAborted()
      let pending = mcpClients.get(server.serverName)
      if (!pending) {
        pending = McpClient.connect(server, {
          signal: mcpLifetime.signal,
          authentication: options.mcpAuthentication?.[server.serverName]
        })
        mcpClients.set(server.serverName, pending)
        void pending.catch(() => {
          if (mcpClients.get(server.serverName) === pending) mcpClients.delete(server.serverName)
        })
      }
      try {
        const client = await pending
        signal.throwIfAborted()
        result.push(...(await client.tools({ signal })))
      } catch (error) {
        if (signal.aborted) throw error
        if (mcpClients.get(server.serverName) === pending) mcpClients.delete(server.serverName)
        await pending.then((client) => client.close()).catch(() => {})
        throw error
      }
    }
    if (mcpEnabled) {
      for (const plugin of plugins) result.push(...(await plugin.tools({ signal })))
    }
    return result
  }
  let runtime: LoadedNodePlugins | undefined
  let runtimePromise: Promise<LoadedNodePlugins> | undefined

  return {
    plugins,
    workspaces,
    toolCatalog: async (execution) =>
      (await runtime?.tools?.(execution))?.map(({ name, description }) => ({ name, description })) ?? [],
    async setup(ctx) {
      workspaces.setup(ctx)
      ctx.effect(() => async () => {
        mcpLifetime.abort()
        await Promise.allSettled([...mcpClients.values()].map(async (client) => (await client).close()))
        mcpClients.clear()
        const results = await Promise.allSettled(plugins.map((plugin) => plugin.close()))
        const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
        if (errors.length) throw new AggregateError(errors, 'failed to dispose agent plugins')
      })
      for (const config of options.plugins ?? []) {
        const plugin = await loadAgentPlugin(mcpEnabled ? config : { ...config, mcp: undefined })
        plugins.push(plugin)
        skillProviders.push(plugin.skillProvider)
      }
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
        deferredToolProvider
      })
      runtime = await runtimePromise
      await runtime.setup(ctx)
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
      if (config.codingThreadId && config.workspacePath) {
        const backendContext = ctx.isolate('fs')
        let backend!: LocalFileSystemService
        await backendContext.plugin((child: Context) => {
          backend = new LocalFileSystemService(child, { cwd: config.workspacePath })
        })
        const files = ctx.isolate('fs')
        await files.plugin((child: Context) => {
          new PolicyFileSystemService(child, {
            backend,
            roots: [config.workspacePath!],
            writableRoots: [config.workspacePath!]
          })
        })
        let tools!: readonly ExecutableTool[]
        await files.plugin(
          Object.assign(
            (child: Context) => {
              tools = new FileSystemToolsService(child).tools.map((tool) => ({
                ...tool,
                async execute(args, execution) {
                  const path = args.path
                  if (typeof path !== 'string' || path.split(/[\\/]/).some((part) => part.toLowerCase() === '.git'))
                    throw new Error('Git metadata is not accessible to file tools')
                  const canonical = await child.fs.resolve(path, { signal: execution.signal })
                  if (canonical.split(/[\\/]/).some((part) => part.toLowerCase() === '.git'))
                    throw new Error('Git metadata is not accessible to file tools')
                  return tool.execute(args, execution)
                }
              }))
            },
            { inject: ['fs'] }
          )
        )
        const { codingThreadId: _thread, workspacePath: _path, ...agentConfig } = config
        return files.plugin(codingAgentPlugin, {
          ...agentConfig,
          maxToolRounds: options.maxToolRounds ?? 8,
          skills: false,
          promptPresets: false,
          subagents: false,
          tools
        })
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
