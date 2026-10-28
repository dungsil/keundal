import { inspectAgentPlugin } from '@keundal/agent-plugins/browser'
import type { AgentPluginInfo, AgentPluginManager, AgentPluginSettings } from '@keundal/chat/platform'
import type { ExecutionOptions } from '@keundal/core'
import { parseMcpServers } from '@keundal/mcp'
import type { SkillProvider } from '@keundal/skill'

import { McpManager } from './mcp.js'

const key = 'keundal:agent-plugins'
type InstalledPlugin = AgentPluginSettings & { files: Record<string, string> }

export class BrowserAgentPluginManager implements AgentPluginManager {
  private readonly mcp: McpManager
  private records: InstalledPlugin[]
  readonly provider: SkillProvider

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>) {
    this.records = JSON.parse(storage.getItem(key) ?? '[]') as InstalledPlugin[]
    if (!Array.isArray(this.records)) throw new Error('Invalid agent plugin settings')
    this.mcp = new McpManager()
    this.provider = {
      name: 'agent-plugins',
      prepare: async (options) => {
        options?.signal?.throwIfAborted()
        const plugins = await this.inspect()
        options?.signal?.throwIfAborted()
        const selected = new Map<
          string,
          { skill: (typeof plugins)[number]['skills'][number]; plugin: (typeof plugins)[number] }
        >()
        for (const [index, plugin] of plugins.entries()) {
          if (!this.records[index]!.enabled) continue
          for (const skill of plugin.skills) if (!selected.has(skill.name)) selected.set(skill.name, { skill, plugin })
        }
        const skills = [...selected.values()].map(({ skill }) => skill)
        return {
          skills: skills.map(({ name, description }) => ({ name, description })),
          async load(name, execution) {
            options?.signal?.throwIfAborted()
            execution?.signal?.throwIfAborted()
            return skills.find((skill) => skill.name === name)
          },
          async readResource(name, path, execution) {
            options?.signal?.throwIfAborted()
            execution?.signal?.throwIfAborted()
            return selected.get(name)?.plugin.readResource(name, path, execution)
          }
        }
      }
    }
  }

  private inspect() {
    return Promise.all(this.records.map((record) => inspectAgentPlugin(record.files)))
  }

  async list(): Promise<AgentPluginInfo[]> {
    return (await this.inspect()).map((plugin, i) => ({
      enabled: this.records[i]!.enabled,
      permissions: structuredClone(this.records[i]!.permissions),
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      skills: plugin.skills.map((skill) => skill.name),
      servers: plugin.servers.map((server) => ({
        name: server.serverName,
        url: server.transport === 'streamable-http' ? server.url : ''
      })),
      diagnostics: plugin.diagnostics
    }))
  }

  async import(files: Record<string, string>, restart: () => Promise<void>) {
    const plugin = await inspectAgentPlugin(files)
    if ((await this.list()).some((item) => item.name === plugin.manifest.name))
      throw new Error(`Plugin already installed: ${plugin.manifest.name}`)
    await this.save([...this.records, { files, enabled: false, permissions: {} }], restart)
  }

  async configure(name: string, settings: AgentPluginSettings, restart: () => Promise<void>) {
    settings = JSON.parse(JSON.stringify(settings)) as AgentPluginSettings
    const plugins = await this.inspect()
    const index = plugins.findIndex((plugin) => plugin.manifest.name === name)
    if (index < 0) throw new Error('Plugin not found')
    parseMcpServers(
      plugins[index]!.servers.map((server) => ({ ...server, permissions: settings.permissions[server.serverName] })),
      false
    )
    const next = [...this.records]
    next[index] = { files: next[index]!.files, enabled: settings.enabled, permissions: settings.permissions }
    await this.save(next, restart)
  }

  async remove(name: string, restart: () => Promise<void>) {
    const plugins = await this.inspect()
    await this.save(
      this.records.filter((_, i) => plugins[i]!.manifest.name !== name),
      restart
    )
  }

  private async save(next: InstalledPlugin[], restart: () => Promise<void>) {
    await restart()
    this.storage.setItem(key, JSON.stringify(next))
    await this.mcp.close()
    this.records = structuredClone(next)
    this.initializing = undefined
  }

  private async syncMcp() {
    const plugins = await this.inspect()
    const servers = (
      await Promise.all(
        plugins.map(async (plugin, i) => {
          const record = this.records[i]!
          if (!record.enabled) return []
          return Promise.all(
            plugin.servers
              .filter((server) => {
                const permissions = record.permissions[server.serverName]
                return (
                  permissions?.tools === '*' ||
                  !!permissions?.tools?.length ||
                  permissions?.resources === '*' ||
                  !!permissions?.resources?.length
                )
              })
              .map(async (server) => {
                const digest = await crypto.subtle.digest(
                  'SHA-256',
                  new TextEncoder().encode(JSON.stringify([plugin.manifest.name, server.serverName]))
                )
                return {
                  ...server,
                  serverName: `plugin_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
                    .join('')
                    .slice(0, 24)}`,
                  permissions: record.permissions[server.serverName]
                }
              })
          )
        })
      )
    ).flat()
    await this.mcp.save(servers, async () => {})
  }

  private initializing?: Promise<void>
  async tools(options: ExecutionOptions = {}) {
    options.signal?.throwIfAborted()
    await (this.initializing ??= this.syncMcp().catch((error) => {
      this.initializing = undefined
      throw error
    }))
    options.signal?.throwIfAborted()
    return this.mcp.tools(options)
  }

  close() {
    return this.mcp.close()
  }
}
