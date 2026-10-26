import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createNodeComposition,
  getRequiredNodePluginModules,
  nodePluginMetadata,
  type BundledPluginModule,
  type HostCompositionFactory
} from '@keundal/agent-runtime-node'
import type { RuntimePluginInfo } from '@keundal/chat/platform'
import { metadata as chartMetadata } from '@keundal/plugin-tool-chart'
import { metadata as weatherMetadata } from '@keundal/plugin-tool-weather'

const metadata: Record<string, RuntimePluginInfo['metadata']> = {
  ...nodePluginMetadata,
  '@keundal/plugin-tool-chart': chartMetadata,
  '@keundal/plugin-tool-weather': weatherMetadata
}

const optionalModules: readonly BundledPluginModule[] = [
  '@keundal/plugin-skill',
  '@keundal/plugin-mcp-client',
  '@keundal/plugin-tool-chart',
  '@keundal/plugin-tool-weather'
]
const legacyToolsModule = '@keundal/plugin-tool-chat'
type Entry = { module: BundledPluginModule; enabled: boolean }
export type PluginRequest =
  | { action: 'list' }
  | { action: 'enable'; module: string; enabled: boolean }
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

function validateEntries(value: unknown): Entry[] {
  const modules = Array.isArray(value) && value.length === 3
    ? ['@keundal/plugin-skill', '@keundal/plugin-mcp-client', legacyToolsModule] as const
    : optionalModules
  if (!Array.isArray(value) || value.length !== modules.length) throw new Error('Invalid bundled selection')
  const entries = modules.map((module) => {
    const matches = value.filter((entry) => record(entry) && entry.module === module)
    const entry = matches[0]
    if (matches.length !== 1 || !record(entry) || typeof entry.enabled !== 'boolean' ||
      Object.keys(entry).some((key) => key !== 'module' && key !== 'enabled')) {
      throw new Error('Invalid bundled selection')
    }
    return { module, enabled: entry.enabled }
  })
  return optionalModules.map((module) => ({
    module,
    enabled: entries.find((entry) => entry.module === module)?.enabled
      ?? entries.find((entry) => entry.module === legacyToolsModule)!.enabled
  }))
}

function readEntries(directory: string): Entry[] {
  const path = join(directory, 'bundled-selection.json')
  if (existsSync(path)) return validateEntries(JSON.parse(readFileSync(path, 'utf8')))
  // Only known boolean preferences migrate. Old paths, exports and configs are never used.
  const legacyPath = join(directory, 'managed.json')
  let legacy: unknown = []
  try {
    if (existsSync(legacyPath)) legacy = JSON.parse(readFileSync(legacyPath, 'utf8'))
  } catch { /* Ignore obsolete installer state. */ }
  return optionalModules.map((module) => {
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
    if (Array.isArray(value) && value.every((module) => typeof module === 'string')) return value
  }
  const provider = process.env.KEUNDAL_PROVIDER ||
    (process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : 'anthropic')
  return [`@keundal/plugin-llm-${provider}`, '@keundal/plugin-store-sqlite', '@keundal/plugin-agent-chat']
}

export async function manageRuntimePlugins(directory: string, request: PluginRequest) {
  if (!record(request)) throw new Error('Invalid plugin request')
  const allowedKeys = request.action === 'list' ? ['action'] : request.action === 'enable'
    ? ['action', 'module', 'enabled'] : request.action === 'restore' ? ['action', 'previous', 'expected'] : []
  if (!allowedKeys.length || Object.keys(request).some((key) => !allowedKeys.includes(key))) {
    throw new Error('Unknown plugin operation or field')
  }
  const previous = readEntries(directory)
  if (request.action === 'list') {
    const required = requiredModules(directory)
    return [
      ...required.map((module): RuntimePluginInfo => ({ module, enabled: true, required: true })),
      ...previous.filter((entry) => !required.includes(entry.module))
    ].map((entry): RuntimePluginInfo => ({
      ...entry,
      metadata: metadata[entry.module],
      feature: entry.module === '@keundal/plugin-skill' ? 'skills'
        : entry.module === '@keundal/plugin-mcp-client' ? 'mcp' : undefined
    }))
  }
  let next: Entry[]
  if (request.action === 'restore') {
    const expected = validateEntries(request.expected)
    next = validateEntries(request.previous)
    if (JSON.stringify(previous) !== JSON.stringify(expected)) throw new Error('Plugin selection changed before rollback')
  } else {
    if (!optionalModules.includes(request.module as BundledPluginModule) || requiredModules(directory).includes(request.module)) {
      throw new Error('Plugin is required or is not a bundled optional module')
    }
    if (typeof request.enabled !== 'boolean') throw new Error('Plugin enabled must be a boolean')
    next = previous.map((entry) => entry.module === request.module ? { ...entry, enabled: request.enabled } : entry)
  }
  save(directory, 'bundled-selection.json', next)
  return { previous, expected: next }
}

/** Managed desktop state selects only statically bundled features, never module specifiers. */
export function createDesktopComposition(directory?: string): HostCompositionFactory {
  return (options) => {
    const selection = directory ? Object.fromEntries(readEntries(directory).map(({ module, enabled }) => [module, enabled])) : {}
    const base = createNodeComposition({ ...options, bundledPlugins: { ...options.bundledPlugins, ...selection } })
    return {
      ...base,
      async setup(ctx) {
        await base.setup(ctx)
        // The IPC process does not receive secure provider settings. Record the actual live selection.
        if (directory) save(directory, 'required-modules.json', getRequiredNodePluginModules(options))
      }
    }
  }
}
