import { loadAgentPlugin, type LoadedAgentPlugin } from '@keundal/agent-plugins'
import type { ExecutionOptions } from '@keundal/core'
import { parseMcpServers } from '@keundal/mcp'
import { McpClient } from '@keundal/plugin-mcp-client'
import type { SkillProvider } from '@keundal/skill'
import type { ExecutableTool } from '@keundal/tools'
import type { Context } from 'cordis'

import type { NodeHostOptions } from './index.js'

/** Owns Agent Plugins, their skills, and MCP connection lifetimes for one host. */
export function createNodeAgentIntegrations(options: NodeHostOptions, mcpEnabled: boolean) {
  const plugins: LoadedAgentPlugin[] = []
  const skillProviders: SkillProvider[] = []
  const servers = mcpEnabled ? parseMcpServers(options.mcpServers ?? []) : []
  const clients = new Map<string, Promise<McpClient>>()
  const lifetime = new globalThis.AbortController()

  return {
    plugins,
    skillProviders,
    async setup(ctx: Context) {
      ctx.effect(() => async () => {
        lifetime.abort()
        await Promise.allSettled([...clients.values()].map(async (client) => (await client).close()))
        clients.clear()
        const results = await Promise.allSettled(plugins.map((plugin) => plugin.close()))
        const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
        if (errors.length) throw new AggregateError(errors, 'failed to dispose agent plugins')
      })
      for (const config of options.plugins ?? []) {
        const plugin = await loadAgentPlugin(mcpEnabled ? config : { ...config, mcp: undefined }, {
          connectMcp: (server, execution) => McpClient.connect(server, execution)
        })
        plugins.push(plugin)
        skillProviders.push(plugin.skillProvider)
      }
    },
    async tools(execution: ExecutionOptions): Promise<ExecutableTool[]> {
      const signal = execution.signal
        ? globalThis.AbortSignal.any([execution.signal, lifetime.signal])
        : lifetime.signal
      const result: ExecutableTool[] = []
      for (const server of servers) {
        signal.throwIfAborted()
        let pending = clients.get(server.serverName)
        if (!pending) {
          pending = McpClient.connect(server, {
            signal: lifetime.signal,
            authentication: options.mcpAuthentication?.[server.serverName]
          })
          clients.set(server.serverName, pending)
          void pending.catch(() => {
            if (clients.get(server.serverName) === pending) clients.delete(server.serverName)
          })
        }
        try {
          const client = await pending
          signal.throwIfAborted()
          result.push(...(await client.tools({ signal })))
        } catch (error) {
          if (signal.aborted) throw error
          if (clients.get(server.serverName) === pending) clients.delete(server.serverName)
          await pending.then((client) => client.close()).catch(() => {})
          throw error
        }
      }
      if (mcpEnabled) {
        for (const plugin of plugins) result.push(...(await plugin.tools({ signal })))
      }
      return result
    }
  }
}
