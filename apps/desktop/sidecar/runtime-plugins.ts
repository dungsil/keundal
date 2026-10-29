import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createNodeComposition,
  getConfiguredNodePluginModules,
  getRequiredNodePluginModules,
  nodePluginMetadata,
  type BundledPluginModule,
  type HostCompositionFactory
} from '@keundal/agent-runtime-node'
import type { RuntimePluginInfo } from '@keundal/chat/platform'
import { mountRuntimePlugin } from '@keundal/plugin-runtime'
import { metadata as chartMetadata } from '@keundal/plugin-tool-chart'
import { metadata as todoMetadata } from '@keundal/plugin-tool-todo'
import { metadata as weatherMetadata } from '@keundal/plugin-tool-weather'

import { mountDshBundle } from './dsh-plugins.js'
import { installPlugin, installedDirectory, validateSource, type InstalledPlugin } from './install-plugin.js'

const metadata: Record<string, RuntimePluginInfo['metadata']> = {
  ...nodePluginMetadata,
  '@keundal/plugin-tool-chart': chartMetadata,
  '@keundal/plugin-tool-todo': todoMetadata,
  '@keundal/plugin-tool-weather': weatherMetadata
}

const optionalModules: readonly BundledPluginModule[] = [
  '@keundal/plugin-skill',
  '@keundal/plugin-mcp-client',
  '@keundal/plugin-tool-chart',
  '@keundal/plugin-tool-weather',
  '@keundal/prompt',
  '@keundal/subagent',
  '@keundal/plugin-agent-chat',
  '@keundal/plugin-tool-todo'
]
const legacyToolsModule = '@keundal/plugin-tool-chat'
type Entry = { module: string; enabled: boolean } | InstalledPlugin
export type PluginRequest =
  | { action: 'list' }
  | { action: 'enable'; module: string; enabled: boolean }
  | { action: 'install'; source: import('@keundal/chat/platform').RuntimePluginSource }
  | { action: 'remove'; module: string }
  | { action: 'finalize'; previous: Entry[]; expected: Entry[] }
  | { action: 'restore'; previous: Entry[]; expected: Entry[] }

function save(directory: string, name: string, value: unknown) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateEntries(value: unknown, configured: readonly string[] = []): Entry[] {
  const legacy = Array.isArray(value) && value.some(entry => record(entry) && entry.module === legacyToolsModule)
  const modern = Array.isArray(value) && value.some(entry => record(entry) && optionalModules.slice(4).includes(entry.module as BundledPluginModule))
  const modules = legacy
    ? ['@keundal/plugin-skill', '@keundal/plugin-mcp-client', legacyToolsModule] as const
    : modern ? optionalModules.filter(module => module !== '@keundal/plugin-tool-todo' || value.some(entry => record(entry) && entry.module === module)) : optionalModules.slice(0, 4)
  if (!Array.isArray(value) || value.length < modules.length) throw new Error('Invalid bundled selection')
  const entries = modules.map((module) => {
    const matches = value.filter((entry) => record(entry) && entry.module === module)
    const entry = matches[0]
    if (matches.length !== 1 || !record(entry) || typeof entry.enabled !== 'boolean' ||
      Object.keys(entry).some((key) => key !== 'module' && key !== 'enabled')) {
      throw new Error('Invalid bundled selection')
    }
    return { module, enabled: entry.enabled }
  })
  const bundled = optionalModules.map((module) => ({
    module,
    enabled: entries.find((entry) => entry.module === module)?.enabled
      ?? ((module === '@keundal/plugin-tool-chart' || module === '@keundal/plugin-tool-weather')
        ? entries.find((entry) => entry.module === legacyToolsModule)?.enabled : undefined)
      ?? true
  }))
  const configuredEntries = configured.filter(module => !optionalModules.includes(module as BundledPluginModule)).map(module => {
    const matches = value.filter(entry => record(entry) && entry.module === module)
    if (matches.length > 1 || matches.some(entry => !record(entry) || typeof entry.enabled !== 'boolean' ||
      Object.keys(entry).some(key => key !== 'module' && key !== 'enabled'))) throw new Error('Invalid bundled selection')
    return { module, enabled: matches.length ? Boolean((matches[0] as Record<string, unknown>).enabled) : true }
  })
  const external = value.filter(entry => !record(entry) ||
    ![...modules, ...configuredEntries.map(entry => entry.module)].includes(entry.module as string))
  const seen = new Set<string>()
  for (const entry of external) {
    if (!record(entry) || typeof entry.module !== 'string' || !/^external:[a-f0-9-]{36}$/.test(entry.module) ||
      seen.has(entry.module) || typeof entry.enabled !== 'boolean' || typeof entry.resolvedModule !== 'string' ||
      !entry.resolvedModule.startsWith('file:') ||
      (entry.format !== undefined && entry.format !== 'dsh') ||
      Object.keys(entry).some(key => !['module', 'enabled', 'source', 'resolvedModule', 'format', 'metadata', 'version'].includes(key))) {
      throw new Error('Invalid external selection')
    }
    validateSource(entry.source)
    if (entry.version !== undefined && typeof entry.version !== 'string') throw new Error('Invalid external version')
    if (entry.metadata !== undefined && (!record(entry.metadata) ||
      !['name', 'description'].every(key => record(entry.metadata) && record(entry.metadata[key]) &&
        ['en', 'ko'].every(locale => typeof (entry.metadata as Record<string, Record<string, unknown>>)[key][locale] === 'string')))) {
      throw new Error('Invalid external metadata')
    }
    seen.add(entry.module)
  }
  return [...bundled, ...configuredEntries, ...external as InstalledPlugin[]]
}

function configuredModules(directory: string): string[] {
  const path = join(directory, 'configured-modules.json')
  if (!existsSync(path)) return []
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value) || !value.every(module => typeof module === 'string')) throw new Error('Invalid configured modules')
  return value
}

function readEntries(directory: string, configured = configuredModules(directory)): Entry[] {
  const path = join(directory, 'bundled-selection.json')
  if (existsSync(path)) return validateEntries(JSON.parse(readFileSync(path, 'utf8')), configured)
  // Only known boolean preferences migrate. Old paths, exports and configs are never used.
  const legacyPath = join(directory, 'managed.json')
  let legacy: unknown = []
  try {
    if (existsSync(legacyPath)) legacy = JSON.parse(readFileSync(legacyPath, 'utf8'))
  } catch { /* Ignore obsolete installer state. */ }
  return [...optionalModules, ...configured.filter(module => !optionalModules.includes(module as BundledPluginModule))].map((module) => {
    const entries = Array.isArray(legacy) ? legacy : []
    const entry = entries.find((entry) => record(entry) && entry.module === module && typeof entry.enabled === 'boolean')
      ?? (module === '@keundal/plugin-tool-chart' || module === '@keundal/plugin-tool-weather'
        ? entries.find((entry) => record(entry) && entry.module === legacyToolsModule)
        : undefined)
    return { module, enabled: record(entry) && typeof entry.enabled === 'boolean' ? entry.enabled : true }
  })
}

function requiredModules(directory: string): string[] {
  const path = join(directory, 'required-modules.json')
  if (existsSync(path)) {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(value) && value.every((module) => typeof module === 'string')) return value.filter(module =>
      module.startsWith('@keundal/plugin-llm-') || module.startsWith('@keundal/plugin-store-'))
  }
  const provider = process.env.KEUNDAL_PROVIDER ||
    (process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : 'anthropic')
  return [`@keundal/plugin-llm-${provider}`, '@keundal/plugin-store-sqlite']
}

export async function manageRuntimePlugins(directory: string, request: PluginRequest) {
  if (!record(request)) throw new Error('Invalid plugin request')
  const allowedKeys = request.action === 'list' ? ['action'] : request.action === 'enable'
    ? ['action', 'module', 'enabled'] : request.action === 'install' ? ['action', 'source']
    : request.action === 'remove' ? ['action', 'module']
    : request.action === 'restore' || request.action === 'finalize' ? ['action', 'previous', 'expected'] : []
  if (!allowedKeys.length || Object.keys(request).some((key) => !allowedKeys.includes(key))) {
    throw new Error('Unknown plugin operation or field')
  }
  const previous = readEntries(directory)
  if (request.action === 'list') {
    const required = requiredModules(directory)
    const diagnosticsPath = join(directory, 'diagnostics.json')
    const diagnostics = existsSync(diagnosticsPath) ? JSON.parse(readFileSync(diagnosticsPath, 'utf8')) : {}
    return [
      ...required.map((module): RuntimePluginInfo => ({ module, enabled: true, required: true })),
      ...previous.filter((entry) => !required.includes(entry.module))
    ].map((entry): RuntimePluginInfo => ({
      module: entry.module, enabled: entry.enabled,
      ...('required' in entry ? { required: true } : {}),
      ...(entry.module === '@keundal/prompt' || entry.module === '@keundal/subagent'
        ? { requires: ['@keundal/plugin-agent-chat'] }
        : entry.module === '@keundal/plugin-agent-chat' ? { requires: required } : {}),
      ...('source' in entry ? { source: entry.source, version: entry.version, metadata: entry.metadata,
        ...(entry.enabled && diagnostics[entry.module] ? { error: String(diagnostics[entry.module]) } : {}) }
        : { metadata: metadata[entry.module] }),
      feature: entry.module === '@keundal/plugin-skill' ? 'skills'
        : entry.module === '@keundal/plugin-mcp-client' ? 'mcp'
        : entry.module === '@keundal/prompt' ? 'prompt'
        : entry.module === '@keundal/subagent' ? 'subagents'
        : entry.module === '@keundal/plugin-agent-chat' ? 'agent' : undefined
    }))
  }
  let next: Entry[]
  if (request.action === 'restore' || request.action === 'finalize') {
    const expected = validateEntries(request.expected, configuredModules(directory))
    next = validateEntries(request.previous, configuredModules(directory))
    if (JSON.stringify(previous) !== JSON.stringify(expected)) throw new Error('Plugin selection changed before rollback')
    if (request.action === 'finalize') {
      for (const entry of next) {
        if ('source' in entry && !previous.some(current => current.module === entry.module)) {
          rmSync(installedDirectory(directory, entry.module), { recursive: true, force: true })
        }
      }
      return { previous, expected: previous }
    }
  } else if (request.action === 'install') {
    const installed = await installPlugin(directory, request.source)
    next = [...previous, installed]
  } else if (request.action === 'remove') {
    if (!previous.some(entry => entry.module === request.module && 'source' in entry)) throw new Error('Only external plugins can be removed')
    next = previous.filter(entry => entry.module !== request.module)
  } else {
    if (!previous.some(entry => entry.module === request.module) || requiredModules(directory).includes(request.module)) {
      throw new Error('Plugin is required or is not an installed optional module')
    }
    if (typeof request.enabled !== 'boolean') throw new Error('Plugin enabled must be a boolean')
    next = previous.map((entry) => entry.module === request.module ? { ...entry, enabled: request.enabled } : entry)
  }
  save(directory, 'bundled-selection.json', next)
  if (request.action === 'restore') {
    for (const entry of previous) {
      if ('source' in entry && !next.some(current => current.module === entry.module)) {
        rmSync(installedDirectory(directory, entry.module), { recursive: true, force: true })
      }
    }
  }
  return { previous, expected: next }
}

/** Desktop-managed optional plugins are independent from the deployment manifest. */
export function createDesktopComposition(directory?: string): HostCompositionFactory {
  return (options) => {
    const required = getRequiredNodePluginModules(options)
    const configured = getConfiguredNodePluginModules(options).filter(module => !required.includes(module) && module !== legacyToolsModule)
    const entries = directory ? readEntries(directory, [...new Set([...configuredModules(directory), ...configured])]) : []
    const selection = Object.fromEntries(entries.filter(entry => !('source' in entry)).map(({ module, enabled }) => [module, enabled]))
    const base = createNodeComposition({ ...options, bundledPlugins: { ...options.bundledPlugins, ...selection } })
    return {
      ...base,
      async setup(ctx) {
        await base.setup(ctx)
        // The IPC process does not receive secure provider settings. Record the actual live selection.
        if (directory) {
          save(directory, 'required-modules.json', getRequiredNodePluginModules(options))
          save(directory, 'configured-modules.json', [...new Set([...configuredModules(directory), ...configured])])
          const diagnostics: Record<string, string> = {}
          for (const entry of entries) {
            if (!('source' in entry) || !entry.enabled) continue
            try {
              if (entry.format === 'dsh') {
                await mountDshBundle(ctx, fileURLToPath(entry.resolvedModule))
              } else {
                await mountRuntimePlugin(ctx, { module: entry.resolvedModule }, {
                  importModule: async specifier => await import(/* @vite-ignore */ specifier)
                })
              }
            } catch (error) {
              diagnostics[entry.module] = error instanceof Error ? error.message : String(error)
            }
          }
          save(directory, 'diagnostics.json', diagnostics)
        }
      }
    }
  }
}
