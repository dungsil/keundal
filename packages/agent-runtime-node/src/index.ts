import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

import agentPlugin from '@keundal/agent'
import type { AgentConfig } from '@keundal/agent-contract'
import { createAgentHost, type AgentHostOptions, type AgentHost } from '@keundal/agent-host'
import { createAgentApp, type AgentAppOptions } from '@keundal/agent-host/http'
import { loadAgentPlugin, type AgentPluginOptions, type LoadedAgentPlugin } from '@keundal/agent-plugins'
import { McpClient, parseMcpServers, type McpClientConfig } from '@keundal/mcp'
import anthropic from '@keundal/plugin-llm-anthropic'
import gemini from '@keundal/plugin-llm-gemini'
import openai from '@keundal/plugin-llm-openai'
import skillPlugin from '@keundal/plugin-skill'
import sqlite from '@keundal/plugin-store-sqlite'

export type AgentHostProvider = 'openai' | 'gemini' | 'anthropic'
export interface NodeHostOptions {
  readonly plugins?: readonly AgentPluginOptions[]
  readonly mcpServers?: readonly McpClientConfig[]
  readonly provider: AgentHostProvider
  readonly apiKey: string
  /** 기본 모델 ID입니다. `models`에 포함되어야 합니다. */
  readonly model: string
  /** 사용할 수 있는 모델과 한도입니다. */
  readonly models?: Readonly<Record<string, Omit<import('@keundal/agent-host').AgentHostModel, 'id' | 'provider'>>>
  readonly sqlitePath: string
  readonly maxOutputTokens?: number
  readonly tools?: AgentConfig['tools']
  readonly subagents?: boolean
  readonly maxActiveSubagents?: number
  readonly maxToolRounds?: number
  readonly baseURL?: string
  readonly headers?: Readonly<Record<string, string>>
}

export type HostComposition = Pick<AgentHostOptions, 'setup' | 'mountAgent'> & {
  plugins?: readonly LoadedAgentPlugin[]
}
export type HostCompositionFactory = (options: NodeHostOptions) => HostComposition

/** Built-in Node profile; applications can supply another composition. */
export const createNodeComposition: HostCompositionFactory = (options) => {
  const plugins: LoadedAgentPlugin[] = []
  const mcpServers = parseMcpServers(options.mcpServers ?? [])
  const mcpClients = new Map<string, Promise<McpClient>>()
  const mcpLifetime = new globalThis.AbortController()
  return {
    plugins,
    async setup(ctx) {
      ctx.effect(() => async () => {
        mcpLifetime.abort()
        await Promise.allSettled([...mcpClients.values()].map(async (client) => (await client).close()))
        mcpClients.clear()
        const results = await Promise.allSettled(plugins.map((plugin) => plugin.close()))
        const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
        if (errors.length) throw new AggregateError(errors, 'failed to dispose agent plugins')
      })
      for (const config of options.plugins ?? []) plugins.push(await loadAgentPlugin(config))
      if (plugins.length) await ctx.plugin(skillPlugin, { providers: plugins.map((plugin) => plugin.skillProvider) })
      const providers = { openai, anthropic, gemini }
      await ctx.plugin(providers[options.provider], {
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        headers: options.headers,
        models: options.models ?? { [options.model]: { contextWindow: 128000, maxOutputTokens: 4096 } }
      })
      if (options.sqlitePath !== ':memory:') mkdirSync(dirname(options.sqlitePath), { recursive: true })
      await ctx.plugin(sqlite, { path: options.sqlitePath })
    },
    mountAgent: async (ctx, config) =>
      ctx.plugin(agentPlugin, {
        ...config,
        reasoning:
          options.provider === 'openai' && !/^(gpt-5|o\d)(?:[-.]|$)/.test(config.model) ? undefined : config.reasoning,
        skills: plugins.length > 0,
        subagents: options.subagents ?? true,
        maxActiveSubagents: options.maxActiveSubagents,
        parallelTools: true,
        tools: async (execution) => {
          const signal = execution?.signal
            ? globalThis.AbortSignal.any([execution.signal, mcpLifetime.signal])
            : mcpLifetime.signal
          const tools = [
            ...(typeof options.tools === 'function' ? await options.tools({ signal }) : (options.tools ?? []))
          ]
          for (const server of mcpServers) {
            signal.throwIfAborted()
            let pending = mcpClients.get(server.serverName)
            if (!pending) {
              pending = McpClient.connect(server, { signal })
              mcpClients.set(server.serverName, pending)
              void pending.catch(() => {
                if (mcpClients.get(server.serverName) === pending) mcpClients.delete(server.serverName)
              })
            }
            try {
              tools.push(...(await (await pending).tools({ signal })))
            } catch (error) {
              if (signal.aborted) throw error
              if (mcpClients.get(server.serverName) === pending) mcpClients.delete(server.serverName)
              await pending.then((client) => client.close()).catch(() => {})
              throw error
            }
          }
          for (const plugin of plugins) tools.push(...(await plugin.tools({ signal })))
          return tools
        }
      })
  }
}

export async function createNodeAgentHost(options: NodeHostOptions, compose: HostCompositionFactory) {
  const models = options.models ?? { [options.model]: { contextWindow: 128000, maxOutputTokens: 4096 } }
  const composition = compose(options)
  const host = await createAgentHost({
    model: options.model,
    models: Object.entries(models).map(([id, limits]) => ({ id, provider: options.provider, ...limits })),
    maxOutputTokens: options.maxOutputTokens,
    tools: options.tools,
    maxToolRounds: options.maxToolRounds,
    ...composition
  })
  return { ...host, plugins: composition.plugins ?? [] }
}

export interface AgentRuntime extends AgentHost {
  readonly plugins: readonly LoadedAgentPlugin[]
  readonly app: ReturnType<typeof createAgentApp>
}

/** 웹 서버와 데스크톱이 같은 환경 설정으로 호스트를 조립합니다. */
export async function createAgentRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Pick<NodeHostOptions, 'tools' | 'plugins' | 'subagents' | 'maxActiveSubagents'> & {
    compose: HostCompositionFactory
  }
): Promise<AgentRuntime> {
  const provider = (env.KEUNDAL_PROVIDER ||
    (env.OPENAI_API_KEY ? 'openai' : env.GEMINI_API_KEY ? 'gemini' : 'anthropic')) as AgentHostProvider
  if (!['openai', 'gemini', 'anthropic'].includes(provider)) {
    throw new Error('KEUNDAL_PROVIDER는 openai, gemini, anthropic 중 하나여야 합니다.')
  }
  const apiKey =
    provider === 'openai' ? env.OPENAI_API_KEY : provider === 'gemini' ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY
  const model = env.KEUNDAL_MODEL
  if (!model?.trim()) throw new Error('KEUNDAL_MODEL 환경 변수를 설정하세요.')
  if (!env.KEUNDAL_PROVIDER && !apiKey?.trim())
    throw new Error('OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY 중 하나를 설정하세요.')
  const contextWindow = Number(env.KEUNDAL_CONTEXT_WINDOW ?? 128_000)
  const maxOutputTokens = Number(env.KEUNDAL_MAX_OUTPUT_TOKENS ?? 4_096)
  const appOptions: AgentAppOptions = {
    token: env.KEUNDAL_API_TOKEN ?? '',
    maxRequestBodyBytes:
      env.KEUNDAL_MAX_REQUEST_BODY_BYTES === undefined ? undefined : Number(env.KEUNDAL_MAX_REQUEST_BODY_BYTES),
    allowedOrigins: (env.KEUNDAL_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  }
  const sqlitePath = env.KEUNDAL_SQLITE_PATH ?? '.data/keundal.sqlite'
  const host = await createNodeAgentHost(
    {
      tools: options.tools,
      subagents: options.subagents,
      maxActiveSubagents: options.maxActiveSubagents,
      plugins: options.plugins,
      mcpServers: env.KEUNDAL_MCP_SERVERS ? JSON.parse(env.KEUNDAL_MCP_SERVERS) : [],
      provider,
      apiKey: apiKey ?? '',
      model,
      models: { [model]: { contextWindow, maxOutputTokens } },
      sqlitePath,
      maxOutputTokens,
      baseURL: env.KEUNDAL_BASE_URL || undefined,
      headers: env.KEUNDAL_HEADERS ? (JSON.parse(env.KEUNDAL_HEADERS) as Record<string, string>) : undefined
    },
    options.compose
  )
  try {
    return { ...host, app: createAgentApp(host.services, appOptions) }
  } catch (error) {
    await host.dispose()
    throw error
  }
}
