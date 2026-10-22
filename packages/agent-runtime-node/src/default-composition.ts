import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { loadAgentPlugin, type LoadedAgentPlugin } from '@keundal/agent-plugins'
import type { ExecutionOptions, SkillProvider } from '@keundal/core'
import { parseMcpServers } from '@keundal/mcp'
import agentPlugin from '@keundal/plugin-agent-chat'
import anthropic from '@keundal/plugin-llm-anthropic'
import gemini from '@keundal/plugin-llm-gemini'
import openai from '@keundal/plugin-llm-openai'
import { McpClient } from '@keundal/plugin-mcp-client'
import { loadRuntimePlugins, parseRuntimePluginManifest, type RuntimePluginManifest } from '@keundal/plugin-runtime'
import skillPlugin from '@keundal/plugin-skill'
import sqlite from '@keundal/plugin-store-sqlite'
import type { ExecutableTool, ToolProvider } from '@keundal/tools'
import type { Context, Fiber } from 'cordis'
import { resolve as resolveModule } from 'import-meta-resolve'

import type { HostCompositionFactory, NodeHostOptions } from './index.js'

const providerPlugins = { openai, anthropic, gemini }

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

export const createNodeComposition: HostCompositionFactory = (options) => {
  const plugins: LoadedAgentPlugin[] = []
  const skillProviders: SkillProvider[] = []
  const mcpServers = parseMcpServers(options.mcpServers ?? [])
  const mcpClients = new Map<string, Promise<McpClient>>()
  const mcpLifetime = new globalThis.AbortController()
  const { manifest, basePath } = readManifest(options, Boolean(options.plugins?.length))
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
        skills: Boolean(options.plugins?.length),
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
    for (const plugin of plugins) result.push(...(await plugin.tools({ signal })))
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
        const plugin = await loadAgentPlugin(config)
        plugins.push(plugin)
        skillProviders.push(plugin.skillProvider)
      }
      if (plugins.length && !manifest.plugins.some((spec) => spec.module === 'builtin:skills')) {
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
        reasoning:
          hasBuiltinLlm && builtinLlmProvider === 'openai' && !/^(gpt-5|o\d)(?:[-.]|$)/.test(config.model)
            ? undefined
            : config.reasoning
      })
    }
  }
}
