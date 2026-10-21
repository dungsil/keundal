import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { loadAgentPlugin, type LoadedAgentPlugin } from '@keundal/agent-plugins'
import { parseMcpServers } from '@keundal/mcp'
import agentPlugin from '@keundal/plugin-agent-chat'
import anthropic from '@keundal/plugin-llm-anthropic'
import gemini from '@keundal/plugin-llm-gemini'
import openai from '@keundal/plugin-llm-openai'
import { McpClient } from '@keundal/plugin-mcp-client'
import skillPlugin from '@keundal/plugin-skill'
import sqlite from '@keundal/plugin-store-sqlite'

import type { HostCompositionFactory } from './index.js'

/** 기본 공급자를 선택하는 Node.js 구성입니다. 앱은 다른 구성을 전달할 수 있습니다. */
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
        maxToolRounds: options.maxToolRounds ?? 4,
        skills: plugins.length > 0,
        tools: async (execution) => {
          const signal = execution.signal
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
