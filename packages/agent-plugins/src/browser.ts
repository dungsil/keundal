import type { ExecutionOptions } from '@keundal/core'
import { parseMcpServers, type McpClientConfig } from '@keundal/mcp'
import { isSkillResourcePath, type SkillDefinition } from '@keundal/skill'

import { pluginSkill } from './skill-metadata.js'
import { manifest, mcpServers, server, type PluginDiagnostic } from './validation.js'

export { PLUGIN_SCHEMA, MCP_SCHEMA } from './validation.js'

export async function inspectAgentPlugin(files: Readonly<Record<string, string>>) {
  for (const [path, text] of Object.entries(files)) {
    if (path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..'))
      throw new Error('invalid plugin file path')
    if (typeof text !== 'string') throw new Error('plugin files must contain text')
  }
  const diagnostics: PluginDiagnostic[] = []
  const report = (component: PluginDiagnostic['component'], message: string, entry?: string) => {
    diagnostics.push({ component, message, ...(entry === undefined ? {} : { entry }) })
  }
  const metadata = manifest(JSON.parse(files['plugin.json'] ?? 'null'), report)
  const skills: SkillDefinition[] = []
  const directories = new Map<string, string>()
  for (const path of Object.keys(files).sort()) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path)
    if (!match) continue
    try {
      const skill = await pluginSkill(files[path]!, match[1]!)
      const prefix = `skills/${match[1]!}/`
      const resources = Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length))
        .filter(isSkillResourcePath)
        .sort()
      skills.push(resources.length ? { ...skill, resources } : skill)
      directories.set(skill.name, prefix)
    } catch (error) {
      report('skills', error instanceof Error ? error.message : String(error), match[1])
    }
  }
  const servers: McpClientConfig[] = []
  if (files['mcp.json']) {
    try {
      const entries = mcpServers(JSON.parse(files['mcp.json']))
      for (const [name, raw] of Object.entries(entries)) {
        try {
          const entry = server(raw)
          if (entry.type !== 'streamable-http')
            throw new Error('Browser plugins require Streamable HTTP; stdio and SSE are unavailable.')
          servers.push(
            ...parseMcpServers(
              [
                {
                  serverName: name,
                  transport: 'streamable-http',
                  url: entry.url,
                  ...(entry.headers ? { headers: entry.headers } : {}),
                  redirect: 'error'
                }
              ],
              false
            )
          )
        } catch (error) {
          report('mcp', error instanceof Error ? error.message : String(error), name)
        }
      }
    } catch (error) {
      report('mcp', error instanceof Error ? error.message : String(error))
    }
  }
  return {
    manifest: metadata,
    skills,
    servers,
    diagnostics,
    async readResource(name: string, path: string, options?: ExecutionOptions) {
      options?.signal?.throwIfAborted()
      if (!isSkillResourcePath(path)) throw new Error('invalid skill resource path')
      const prefix = directories.get(name)
      if (!prefix) return undefined
      const key = `${prefix}${path}`
      if (!Object.hasOwn(files, key)) return undefined
      const content = files[key]!
      if (new globalThis.TextEncoder().encode(content).length > 1024 * 1024)
        throw new Error('skill resource exceeds 1 MiB')
      if (content.includes('\0') || content.includes('\uFFFD'))
        throw new Error('skill resource must contain UTF-8 text')
      return content
    }
  }
}
