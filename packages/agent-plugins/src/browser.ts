import type { SkillDefinition } from '@keundal/core'
import { parseMcpServers, type McpClientConfig } from '@keundal/mcp'

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
  for (const path of Object.keys(files).sort()) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path)
    if (!match) continue
    try {
      skills.push(await pluginSkill(files[path]!, match[1]!))
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
  return { manifest: metadata, skills, servers, diagnostics }
}
