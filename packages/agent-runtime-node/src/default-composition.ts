import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { loadAgentPlugin, type LoadedAgentPlugin } from '@keundal/agent-plugins'
import type { ExecutionOptions, SkillProvider } from '@keundal/core'
import { parseMcpServers } from '@keundal/mcp'
import agentPlugin, { metadata as agentMetadata } from '@keundal/plugin-agent-chat'
import anthropic, { metadata as anthropicMetadata } from '@keundal/plugin-llm-anthropic'
import gemini, { metadata as geminiMetadata } from '@keundal/plugin-llm-gemini'
import openai, { metadata as openaiMetadata } from '@keundal/plugin-llm-openai'
import openaiChat, { metadata as openaiChatMetadata } from '@keundal/plugin-llm-openai-chat'
import { McpClient, metadata as mcpMetadata } from '@keundal/plugin-mcp-client'
import { loadRuntimePlugins, parseRuntimePluginManifest, type RuntimePluginManifest } from '@keundal/plugin-runtime'
import skillPlugin, { metadata as skillMetadata } from '@keundal/plugin-skill'
import sqlite, { metadata as storeMetadata } from '@keundal/plugin-store-sqlite'
import type { ExecutableTool, ToolProvider } from '@keundal/tools'
import type { Context, Fiber } from 'cordis'
import { resolve as resolveModule } from 'import-meta-resolve'

import type { HostCompositionFactory, NodeHostOptions } from './index.js'

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
  '@keundal/plugin-mcp-client': mcpMetadata
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

/** Required deployment modules are informational, never editable by bundled feature selection. */
export function getRequiredNodePluginModules(options: NodeHostOptions): string[] {
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
      [...manifest.plugins, manifest.agent]
        .filter((spec) => !['builtin:skills', '@keundal/plugin-skill'].includes(spec.module))
        .map((spec) => builtinNames[spec.module] ?? spec.module)
    )
  ]
}

export const createNodeComposition: HostCompositionFactory = (options) => {
  const plugins: LoadedAgentPlugin[] = []
  const skillProviders: SkillProvider[] = []
  const skillsEnabled = options.bundledPlugins?.['@keundal/plugin-skill'] !== false
  const mcpEnabled = options.bundledPlugins?.['@keundal/plugin-mcp-client'] !== false
  const chatToolsEnabled = options.bundledPlugins?.['@keundal/plugin-tool-chat'] !== false
  const mcpServers = mcpEnabled ? parseMcpServers(options.mcpServers ?? []) : []
  const mcpClients = new Map<string, Promise<McpClient>>()
  const mcpLifetime = new globalThis.AbortController()
  const selection = readManifest(options, skillsEnabled && Boolean(options.plugins?.length))
  const manifest: RuntimePluginManifest = {
    ...selection.manifest,
    plugins: selection.manifest.plugins.filter(
      (spec) => skillsEnabled || !['builtin:skills', '@keundal/plugin-skill'].includes(spec.module)
    ),
    ...(selection.manifest.tools === undefined
      ? {}
      : {
          tools: selection.manifest.tools.filter(
            (spec) => chatToolsEnabled || spec.module !== '@keundal/plugin-tool-chat'
          )
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
  const defaultTools = chatToolsEnabled && manifest.tools === undefined ? options.defaultTools : undefined
  const suppliedTools: ToolProvider | undefined =
    defaultTools || options.tools
      ? async (execution) => [
          ...(typeof defaultTools === 'function' ? await defaultTools(execution) : (defaultTools ?? [])),
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
        pending = McpClient.connect(server, { signal: mcpLifetime.signal })
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
    toolCatalog: async (execution) =>
      (await runtime?.tools?.(execution))?.map(({ name, description }) => ({ name, description })) ?? [],
    async setup(ctx) {
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
    },
    async mountAgent(ctx, config) {
      if (!runtime) throw new Error('runtime plugins are not initialized')
      return runtime.mountAgent(ctx, {
        ...config,
        ...(!skillsEnabled ? { skills: false } : {}),
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
