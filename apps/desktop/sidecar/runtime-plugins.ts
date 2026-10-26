import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createNodeComposition,
  getRequiredNodePluginModules,
  nodePluginMetadata,
  type BundledPluginModule,
  type HostCompositionFactory
} from '@keundal/agent-runtime-node'
import type { RuntimePluginInfo } from '@keundal/chat/platform'
import { mountRuntimePlugin } from '@keundal/plugin-runtime'
import { metadata as toolsMetadata } from '@keundal/plugin-tool-chat'

import { installPlugin, installedDirectory, validateSource, type InstalledPlugin } from './install-plugin.js'

const metadata: Record<string, RuntimePluginInfo['metadata']> = {
  ...nodePluginMetadata,
  '@keundal/plugin-tool-chat': toolsMetadata
}

const optionalModules: readonly BundledPluginModule[] = [
  '@keundal/plugin-skill',
  '@keundal/plugin-mcp-client',
  '@keundal/plugin-tool-chat'
]
type Entry = { module: BundledPluginModule; enabled: boolean } | InstalledPlugin
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

function validateEntries(value: unknown): Entry[] {
  if (!Array.isArray(value) || value.length < optionalModules.length) throw new Error('Invalid bundled selection')
  const bundled = optionalModules.map((module) => {
    const matches = value.filter((entry) => record(entry) && entry.module === module)
    const entry = matches[0]
    if (matches.length !== 1 || !record(entry) || typeof entry.enabled !== 'boolean' ||
      Object.keys(entry).some((key) => key !== 'module' && key !== 'enabled')) {
      throw new Error('Invalid bundled selection')
    }
    return { module, enabled: entry.enabled }
  })
  const external = value.filter(entry => !record(entry) || !optionalModules.includes(entry.module as BundledPluginModule))
  const seen = new Set<string>()
  for (const entry of external) {
    if (!record(entry) || typeof entry.module !== 'string' || !/^external:[a-f0-9-]{36}$/.test(entry.module) ||
      seen.has(entry.module) || typeof entry.enabled !== 'boolean' || typeof entry.resolvedModule !== 'string' ||
      !entry.resolvedModule.startsWith('file:') ||
      Object.keys(entry).some(key => !['module', 'enabled', 'source', 'resolvedModule', 'metadata', 'version'].includes(key))) {
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
  return [...bundled, ...external as InstalledPlugin[]]
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
    const entry = Array.isArray(legacy) ? legacy.find((entry) => record(entry) && entry.module === module) : undefined
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
      ...('source' in entry ? { source: entry.source, version: entry.version, metadata: entry.metadata,
        ...(entry.enabled && diagnostics[entry.module] ? { error: String(diagnostics[entry.module]) } : {}) }
        : { metadata: metadata[entry.module] }),
      feature: entry.module === '@keundal/plugin-skill' ? 'skills'
        : entry.module === '@keundal/plugin-mcp-client' ? 'mcp' : undefined
    }))
  }
  let next: Entry[]
  if (request.action === 'restore' || request.action === 'finalize') {
    const expected = validateEntries(request.expected)
    next = validateEntries(request.previous)
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
    const entries = directory ? readEntries(directory) : []
    const selection = Object.fromEntries(entries.filter(entry => !('source' in entry)).map(({ module, enabled }) => [module, enabled]))
    const base = createNodeComposition({ ...options, bundledPlugins: { ...options.bundledPlugins, ...selection } })
    return {
      ...base,
      async setup(ctx) {
        await base.setup(ctx)
        // The IPC process does not receive secure provider settings. Record the actual live selection.
        if (directory) {
          save(directory, 'required-modules.json', getRequiredNodePluginModules(options))
          const diagnostics: Record<string, string> = {}
          for (const entry of entries) {
            if (!('source' in entry) || !entry.enabled) continue
            try {
              await mountRuntimePlugin(ctx, { module: entry.resolvedModule }, {
                importModule: async specifier => await import(/* @vite-ignore */ specifier)
              })
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
