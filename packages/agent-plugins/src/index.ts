import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

import type { ExecutionOptions, SkillProvider } from '@keundal/core'
import type { McpClientConfig, McpPermissions } from '@keundal/mcp'
import { McpClient } from '@keundal/plugin-mcp-client'
import type { ExecutableTool } from '@keundal/tools'

import { contained, exists } from './files.js'
import { skills } from './skills.js'
import { manifest, mcpServers, server, type PluginDiagnostic, type PluginManifest } from './validation.js'

export { PLUGIN_SCHEMA, MCP_SCHEMA, type PluginDiagnostic, type PluginManifest } from './validation.js'
export interface AgentPluginOptions {
  readonly root: string
  /** Stable directory dedicated to this installed instance, outside the package. */
  readonly dataDirectory: string
  /** Omit to load skills without starting any MCP servers. */
  readonly mcp?: {
    readonly permissions?: Readonly<Record<string, McpPermissions>>
    readonly timeoutMs?: number
  }
}
export interface LoadedAgentPlugin {
  readonly root: string
  readonly manifest: PluginManifest
  readonly diagnostics: readonly PluginDiagnostic[]
  readonly skillProvider: SkillProvider
  tools(options?: ExecutionOptions): Promise<ExecutableTool[]>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export async function loadAgentPlugin(
  config: AgentPluginOptions,
  options: ExecutionOptions = {}
): Promise<LoadedAgentPlugin> {
  options.signal?.throwIfAborted()
  if (!config.root?.trim() || !config.dataDirectory?.trim())
    throw new Error('plugin root and dataDirectory are required')
  const root = await realpath(config.root)
  const diagnostics: PluginDiagnostic[] = []
  const reported = new Set<string>()
  const report = (component: PluginDiagnostic['component'], message: string, entry?: string) => {
    const key = JSON.stringify([component, entry, message])
    if (reported.has(key)) return
    reported.add(key)
    diagnostics.push(Object.freeze({ component, message, ...(entry === undefined ? {} : { entry }) }))
  }
  const manifestPath = await contained(root, 'plugin.json', 'file')
  const metadata = manifest(
    JSON.parse(await readFile(manifestPath, { encoding: 'utf8', signal: options.signal })),
    report
  )
  const lifetime = new globalThis.AbortController()
  const signal = globalThis.AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])])
  const clients = new Map<string, McpClient>()
  let closing: Promise<void> | undefined
  const close = () => {
    lifetime.abort(new Error('agent plugin closed'))
    return (closing ??= (async () => {
      const results = await Promise.allSettled([...clients.values()].map((client) => client.close()))
      clients.clear()
      const errors = results.filter((result) => result.status === 'rejected')
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          'failed to close plugin MCP clients'
        )
    })())
  }
  try {
    signal.throwIfAborted()
    const skillProvider = skills(root, signal, report)
    // Discover now so component diagnostics are available before the first agent run.
    await skillProvider.prepare({ signal })
    if (config.mcp) {
      try {
        if (await exists(resolve(root, 'mcp.json'))) {
          const path = await contained(root, 'mcp.json', 'file')
          const entries = mcpServers(JSON.parse(await readFile(path, { encoding: 'utf8', signal })))
          for (const [name, raw] of Object.entries(entries)) {
            signal.throwIfAborted()
            try {
              const entry = server(raw, process.platform === 'win32')
              if (entry.type === 'sse') {
                report('mcp', 'unsupported transport: sse', name)
                continue
              }
              const base = {
                serverName: `ap_${createHash('sha256')
                  .update(JSON.stringify([root, name]))
                  .digest('hex')
                  .slice(0, 28)}`,
                permissions: config.mcp.permissions?.[name],
                timeoutMs: config.mcp.timeoutMs
              }
              let connection: McpClientConfig
              if (entry.type === 'stdio') {
                await mkdir(config.dataDirectory, { recursive: true })
                const data = await realpath(config.dataDirectory)
                await access(data, constants.W_OK)
                const expand = (text: string) =>
                  text.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, key: string) =>
                    key === 'PLUGIN_ROOT' ? root : data
                  )
                const command = entry.command.startsWith('./')
                  ? await contained(root, entry.command, 'file')
                  : entry.command
                const cwd =
                  entry.cwd === undefined
                    ? root
                    : await contained(
                        entry.cwd.startsWith('${PLUGIN_DATA}') ? data : root,
                        expand(entry.cwd),
                        'directory'
                      )
                connection = {
                  ...base,
                  transport: 'stdio',
                  command,
                  cwd,
                  args: entry.args?.map(expand),
                  env: {
                    ...Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, val]) => [key, expand(val)])),
                    PLUGIN_ROOT: root,
                    PLUGIN_DATA: data
                  }
                }
              } else {
                connection = {
                  ...base,
                  transport: 'streamable-http',
                  url: entry.url,
                  headers: entry.headers,
                  redirect: 'error'
                }
              }
              clients.set(name, await McpClient.connect(connection, { signal }))
            } catch (error) {
              signal.throwIfAborted()
              report('mcp', error instanceof Error ? error.message : String(error), name)
            }
          }
        }
      } catch (error) {
        signal.throwIfAborted()
        report('mcp', error instanceof Error ? error.message : String(error))
      }
    }
    signal.throwIfAborted()
    return {
      root,
      manifest: metadata,
      get diagnostics() {
        return Object.freeze([...diagnostics])
      },
      skillProvider,
      async tools(execution) {
        const current = globalThis.AbortSignal.any([signal, ...(execution?.signal ? [execution.signal] : [])])
        current.throwIfAborted()
        const result: ExecutableTool[] = []
        for (const [name, client] of clients) {
          try {
            result.push(...(await client.tools({ signal: current })))
          } catch (error) {
            current.throwIfAborted()
            report('mcp', error instanceof Error ? error.message : String(error), name)
          }
        }
        current.throwIfAborted()
        return result
      },
      close,
      [Symbol.asyncDispose]: close
    }
  } catch (error) {
    await close()
    throw error
  }
}
