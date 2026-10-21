import type { ExecutionOptions } from '@keundal/core'
import type { ExecutableTool, ToolProvider } from '@keundal/tools'
import type { Context, Fiber, Plugin } from 'cordis'

export interface RuntimeModuleSpec {
  readonly module: string
  readonly export?: string
  readonly config?: Readonly<Record<string, unknown>>
}

export interface RuntimePluginManifest {
  readonly plugins: readonly RuntimeModuleSpec[]
  readonly agent: RuntimeModuleSpec
  readonly tools?: readonly RuntimeModuleSpec[]
}

export type RuntimeModuleImporter = (specifier: string) => Promise<Record<string, unknown>>

export type RuntimeModuleRegistry = Readonly<
  Record<
    string,
    {
      readonly exports: Readonly<Record<string, unknown>>
      readonly config?: Readonly<Record<string, unknown>>
    }
  >
>

export type RuntimeToolFactory = (
  config: Readonly<Record<string, unknown>>,
  execution: ExecutionOptions
) => readonly ExecutableTool[] | Promise<readonly ExecutableTool[]>

export interface LoadRuntimePluginsOptions {
  readonly importModule: RuntimeModuleImporter
  readonly builtins?: RuntimeModuleRegistry
  readonly tools?: ToolProvider
}

interface ResolvedModule {
  readonly plugin: Plugin
  readonly config: Readonly<Record<string, unknown>>
}

interface ResolvedToolFactory {
  readonly factory: RuntimeToolFactory
  readonly config: Readonly<Record<string, unknown>>
}

const hasOwn = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateConfig(value: unknown, label: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  return value
}

function parseModuleSpec(value: unknown, label: string): RuntimeModuleSpec {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  for (const key of Object.keys(value)) {
    if (key !== 'module' && key !== 'export' && key !== 'config') throw new TypeError(`${label} has unknown key: ${key}`)
  }
  if (typeof value.module !== 'string' || !value.module.trim()) {
    throw new TypeError(`${label}.module must be a non-blank string`)
  }
  if (hasOwn(value, 'export') && (typeof value.export !== 'string' || !value.export.trim())) {
    throw new TypeError(`${label}.export must be a non-blank string`)
  }
  const config = validateConfig(value.config, `${label}.config`)
  return {
    module: value.module,
    ...(hasOwn(value, 'export') ? { export: value.export as string } : {}),
    ...(config === undefined ? {} : { config })
  }
}

/** Parses a runtime manifest and rejects invalid or unsupported fields before importing modules. */
export function parseRuntimePluginManifest(value: unknown): RuntimePluginManifest {
  if (!isRecord(value)) throw new TypeError('runtime plugin manifest must be an object')
  for (const key of Object.keys(value)) {
    if (key !== 'plugins' && key !== 'agent' && key !== 'tools') {
      throw new TypeError(`runtime plugin manifest has unknown key: ${key}`)
    }
  }
  if (!hasOwn(value, 'plugins') || !Array.isArray(value.plugins)) {
    throw new TypeError('runtime plugin manifest.plugins must be an array')
  }
  if (!hasOwn(value, 'agent')) throw new TypeError('runtime plugin manifest.agent is required')
  if (hasOwn(value, 'tools') && !Array.isArray(value.tools)) {
    throw new TypeError('runtime plugin manifest.tools must be an array')
  }
  const plugins = value.plugins.map((entry, index) => parseModuleSpec(entry, `plugins[${index}]`))
  const agent = parseModuleSpec(value.agent, 'agent')
  const tools = hasOwn(value, 'tools')
    ? (value.tools as unknown[]).map((entry, index) => parseModuleSpec(entry, `tools[${index}]`))
    : undefined
  return {
    plugins,
    agent,
    ...(tools === undefined ? {} : { tools })
  }
}


function asPlugin(value: unknown, module: string, exportName: string): Plugin {
  if (typeof value === 'function') return value as Plugin
  if (isRecord(value) && hasOwn(value, 'apply') && typeof value.apply === 'function') return value as unknown as Plugin
  throw new TypeError(`export "${exportName}" from "${module}" is not a Cordis plugin`)
}

function asToolFactory(value: unknown, module: string, exportName: string): RuntimeToolFactory {
  if (typeof value !== 'function') {
    throw new TypeError(`export "${exportName}" from "${module}" is not a tool factory`)
  }
  return value as RuntimeToolFactory
}

async function resolveExport(
  spec: RuntimeModuleSpec,
  options: LoadRuntimePluginsOptions
): Promise<{ selected: unknown; config: Readonly<Record<string, unknown>> }> {
  const exportName = spec.export ?? 'default'
  let exports: Readonly<Record<string, unknown>>
  let builtinConfig: Readonly<Record<string, unknown>> | undefined
  if (spec.module.startsWith('builtin:')) {
    const builtins = options.builtins
    const name = spec.module.slice('builtin:'.length)
    if (!builtins || !hasOwn(builtins, name)) throw new Error(`unknown builtin module: ${spec.module}`)
    const builtin = builtins[name]
    exports = builtin.exports
    builtinConfig = builtin.config
  } else {
    exports = await options.importModule(spec.module)
  }
  if (!isRecord(exports) || !hasOwn(exports, exportName)) {
    throw new TypeError(`module "${spec.module}" does not export "${exportName}"`)
  }
  return {
    selected: exports[exportName],
    config: { ...(builtinConfig ?? {}), ...(spec.config ?? {}) }
  }
}

async function resolveModule(spec: RuntimeModuleSpec, options: LoadRuntimePluginsOptions): Promise<ResolvedModule> {
  const { selected, config } = await resolveExport(spec, options)
  return { plugin: asPlugin(selected, spec.module, spec.export ?? 'default'), config }
}

async function resolveToolFactory(
  spec: RuntimeModuleSpec,
  options: LoadRuntimePluginsOptions
): Promise<ResolvedToolFactory> {
  const { selected, config } = await resolveExport(spec, options)
  return { factory: asToolFactory(selected, spec.module, spec.export ?? 'default'), config }
}

/** Resolves module selections without creating a context or installing plugins. */
export async function loadRuntimePlugins(
  manifest: RuntimePluginManifest,
  options: LoadRuntimePluginsOptions
): Promise<{
  setup(ctx: Context): Promise<void>
  mountAgent(ctx: Context, config: Readonly<Record<string, unknown>>): Promise<Fiber>
}> {
  if (manifest.agent.config && hasOwn(manifest.agent.config, 'tools')) {
    throw new TypeError('agent.config.tools is not allowed; configure tools with manifest.tools or options.tools')
  }

  const plugins: ResolvedModule[] = []
  for (const spec of manifest.plugins) plugins.push(await resolveModule(spec, options))
  const agent = await resolveModule(manifest.agent, options)
  if (hasOwn(agent.config, 'tools')) {
    throw new TypeError('agent.config.tools is not allowed; configure tools with manifest.tools or options.tools')
  }
  const tools: ResolvedToolFactory[] = []
  for (const spec of manifest.tools ?? []) tools.push(await resolveToolFactory(spec, options))

  const composedTools: ToolProvider | undefined =
    manifest.tools !== undefined || options.tools !== undefined
      ? async (execution) => {
          const result: ExecutableTool[] = []
          for (const { factory, config } of tools) {
            const generated = await factory(config, execution)
            if (!Array.isArray(generated)) throw new TypeError('runtime tool factory must return an array')
            result.push(...generated)
          }
          if (options.tools) {
            const supplied = await options.tools(execution)
            if (!Array.isArray(supplied)) throw new TypeError('options.tools must return an array')
            result.push(...supplied)
          }
          return result
        }
      : undefined

  return {
    async setup(ctx) {
      for (const { plugin, config } of plugins) await ctx.plugin(plugin, config)
    },
    async mountAgent(ctx, config) {
      const agentConfig = { ...agent.config, ...config }
      if (composedTools) agentConfig.tools = composedTools
      return await ctx.plugin(agent.plugin, agentConfig)
    }
  }
}
