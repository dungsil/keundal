import { inspectAgentPlugin } from '@keundal/agent-plugins/browser'
import type {
  AgentPluginInfo,
  AgentPluginManager,
  AgentPluginSettings,
  AgentPluginUpdate
} from '@keundal/chat/platform'
import type { ExecutionOptions } from '@keundal/core'
import { parseMcpServers, type McpConnector } from '@keundal/mcp'
import type { SkillProvider } from '@keundal/skill'

import { McpManager } from './mcp.js'

const key = 'keundal:agent-plugins'
type InstalledPlugin = AgentPluginSettings & { files: Record<string, string> }

export class BrowserAgentPluginManager implements AgentPluginManager {
  private readonly mcp: McpManager
  private records: InstalledPlugin[]
  private saving = false
  private pendingUpdate?: {
    review: AgentPluginUpdate
    records: InstalledPlugin[]
    index: number
    files: Record<string, string>
  }
  readonly provider: SkillProvider

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    connector?: McpConnector
  ) {
    this.records = JSON.parse(storage.getItem(key) ?? '[]') as InstalledPlugin[]
    if (!Array.isArray(this.records)) throw new Error('Invalid agent plugin settings')
    this.mcp = new McpManager(undefined, { connector })
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
    const records = this.records
    files = JSON.parse(JSON.stringify(files)) as Record<string, string>
    const plugin = await inspectAgentPlugin(files)
    if ((await this.list()).some((item) => item.name === plugin.manifest.name))
      throw new Error(`Plugin already installed: ${plugin.manifest.name}`)
    await this.save([...records, { files, enabled: false, permissions: {} }], restart, records)
  }

  async previewUpdate(name: string, files: Record<string, string>): Promise<AgentPluginUpdate> {
    const records = this.records
    files = JSON.parse(JSON.stringify(files)) as Record<string, string>
    const plugins = await this.inspect()
    const index = plugins.findIndex((plugin) => plugin.manifest.name === name)
    if (index < 0) throw new Error('Plugin not found')
    const plugin = await inspectAgentPlugin(files)
    if (plugin.manifest.name !== name) throw new Error('Plugin name must match the installed plugin')
    const previous = plugins[index]!
    const before = records[index]!.files
    const review: AgentPluginUpdate = {
      id: crypto.randomUUID(),
      name,
      previousVersion: previous.manifest.version,
      version: plugin.manifest.version,
      changes: [...new Set([...Object.keys(before), ...Object.keys(files)])]
        .sort()
        .filter((path) => before[path] !== files[path])
        .map((path) => ({ path, before: before[path], after: files[path] })),
      permissionRequests: plugin.servers
        .filter(
          (server) =>
            JSON.stringify(previous.servers.find((old) => old.serverName === server.serverName)) !==
            JSON.stringify(server)
        )
        .map((server) => {
          const old = previous.servers.find((old) => old.serverName === server.serverName)
          return {
            name: server.serverName,
            url: server.transport === 'streamable-http' ? server.url : '',
            previousUrl: old?.transport === 'streamable-http' ? old.url : undefined
          }
        }),
      diagnostics: plugin.diagnostics
    }
    this.pendingUpdate = { review, records, index, files }
    return structuredClone(review)
  }

  async update(id: string, permissions: AgentPluginSettings['permissions'], restart: () => Promise<void>) {
    const pending = this.pendingUpdate
    if (!pending || pending.review.id !== id) throw new Error('Review this update again before applying it')
    const { review, records, index, files } = pending
    if (records !== this.records) throw new Error('Plugin settings changed; review the update again')
    if (review.diagnostics.some((diagnostic) => diagnostic.component !== 'manifest'))
      throw new Error('Resolve plugin diagnostics before updating')
    permissions = JSON.parse(JSON.stringify(permissions)) as AgentPluginSettings['permissions']
    const next = [...records]
    const approved = { ...records[index]!.permissions }
    for (const request of review.permissionRequests) approved[request.name] = permissions[request.name] ?? {}
    const plugin = await inspectAgentPlugin(files)
    parseMcpServers(
      plugin.servers.map((server) => ({ ...server, permissions: approved[server.serverName] })),
      false
    )
    next[index] = { ...records[index]!, files, permissions: approved }
    await this.save(next, restart, records)
    if (this.pendingUpdate === pending) this.pendingUpdate = undefined
  }

  async configure(name: string, settings: AgentPluginSettings, restart: () => Promise<void>) {
    const records = this.records
    settings = JSON.parse(JSON.stringify(settings)) as AgentPluginSettings
    const plugins = await this.inspect()
    const index = plugins.findIndex((plugin) => plugin.manifest.name === name)
    if (index < 0) throw new Error('Plugin not found')
    parseMcpServers(
      plugins[index]!.servers.map((server) => ({ ...server, permissions: settings.permissions[server.serverName] })),
      false
    )
    const next = [...records]
    next[index] = { files: next[index]!.files, enabled: settings.enabled, permissions: settings.permissions }
    await this.save(next, restart, records)
  }

  async remove(name: string, restart: () => Promise<void>) {
    const records = this.records
    const plugins = await this.inspect()
    await this.save(
      records.filter((_, i) => plugins[i]!.manifest.name !== name),
      restart,
      records
    )
  }

  private async save(next: InstalledPlugin[], restart: () => Promise<void>, previous: InstalledPlugin[]) {
    if (this.saving || previous !== this.records) throw new Error('Plugin settings changed; try again')
    const serialized = JSON.stringify(next)
    this.saving = true
    try {
      await restart()
      // Drain initialization before closing so it cannot reinstall old servers after the swap.
      await this.initializing?.catch(() => {})
      await this.mcp.close()
      this.initializing = undefined
      // localStorage.setItem is atomic: on failure both the saved and in-memory version stay unchanged.
      this.storage.setItem(key, serialized)
      this.records = next
    } finally {
      this.saving = false
    }
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
    if (this.saving) throw new Error('Plugin settings are being updated')
    await (this.initializing ??= this.syncMcp().catch((error) => {
      this.initializing = undefined
      throw error
    }))
    options.signal?.throwIfAborted()
    if (this.saving) throw new Error('Plugin settings are being updated')
    return this.mcp.tools(options)
  }

  close() {
    return this.mcp.close()
  }
}
