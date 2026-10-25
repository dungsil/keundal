import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, delimiter } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createNodeComposition, type HostCompositionFactory } from '@keundal/agent-runtime-node'
import type { RuntimePluginInfo, RuntimePluginSpec } from '@keundal/chat/platform'
import { mountRuntimePlugin } from '@keundal/plugin-runtime'

const execute = promisify(execFile)
interface Entry extends RuntimePluginInfo {
  resolvedModule: string
}
export type PluginRequest =
  | { action: 'list' }
  | { action: 'install'; spec: RuntimePluginSpec }
  | { action: 'enable'; module: string; enabled: boolean }
  | { action: 'remove'; module: string }
  | { action: 'restore'; previous: Entry[]; expected: Entry[] }

function readEntries(directory: string): Entry[] {
  const path = join(directory, 'managed.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
}

function saveEntries(directory: string, entries: Entry[]) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'managed.json')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 })
  renameSync(temporary, path)
}

function validateSpec(spec: RuntimePluginSpec) {
  if (!spec || typeof spec.module !== 'string' || !spec.module.trim()) throw new Error('Plugin module is required')
  if (
    !isAbsolute(spec.module) &&
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*^~+<>=|-]+)?$/.test(spec.module)
  ) {
    throw new Error('Use an npm package name (optionally with a version) or an absolute local module path')
  }
  if (spec.export !== undefined && (typeof spec.export !== 'string' || !spec.export.trim()))
    throw new Error('Invalid plugin export')
  if (spec.config !== undefined && (!spec.config || typeof spec.config !== 'object' || Array.isArray(spec.config)))
    throw new Error('Invalid plugin config')
}

function npmCli(): string {
  const pathDirectories = (process.env.PATH ?? '').split(delimiter)
  const candidates = [
    process.env.KEUNDAL_NPM_CLI,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...pathDirectories.flatMap((path) => [
      join(path, 'node_modules/npm/bin/npm-cli.js'),
      join(path, '../lib/node_modules/npm/bin/npm-cli.js'),
      ...(existsSync(join(path, 'npm')) && realpathSync(join(path, 'npm')).endsWith('npm-cli.js')
        ? [realpathSync(join(path, 'npm'))]
        : [])
    ])
  ]
  const cli = candidates.find((path) => path && existsSync(path))
  if (!cli) throw new Error('npm is required to install plugins; install Node.js/npm or set KEUNDAL_NPM_CLI')
  return cli
}

export async function manageRuntimePlugins(directory: string, request: PluginRequest) {
  const previous = readEntries(directory)
  if (request.action === 'list') {
    const path = join(directory, 'diagnostics.json')
    const diagnostics: Record<string, string> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    return previous.map((entry) => ({
      module: entry.module,
      ...(entry.export === undefined ? {} : { export: entry.export }),
      ...(entry.config === undefined ? {} : { config: entry.config }),
      enabled: entry.enabled,
      ...(entry.enabled && diagnostics[entry.module] ? { error: diagnostics[entry.module] } : {})
    }))
  }
  let next: Entry[]
  if (request.action === 'restore') {
    if (JSON.stringify(previous) !== JSON.stringify(request.expected))
      throw new Error('Plugin selection changed before rollback')
    next = request.previous
  } else if (request.action === 'install') {
    validateSpec(request.spec)
    const spec = request.spec
    if (previous.some((item) => item.module === spec.module)) throw new Error('Plugin is already installed')
    let resolvedModule = spec.module
    if (isAbsolute(spec.module)) {
      if (!existsSync(spec.module)) throw new Error('Local plugin module does not exist')
    } else {
      mkdirSync(join(directory, 'packages'), { recursive: true })
      // Every installation has its own dependency graph; a failed update cannot alter the live one.
      const prefix = mkdtempSync(join(directory, 'packages', 'plugin-'))
      writeFileSync(join(prefix, 'package.json'), '{"private":true,"type":"module"}')
      await execute(
        process.execPath,
        [
          npmCli(),
          'install',
          '--prefix',
          prefix,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--',
          spec.module
        ],
        {
          shell: false,
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, npm_config_ignore_scripts: 'true' }
        }
      )
      const name = spec.module.replace(/(?!^)@[^/]*$/, '')
      const result = await execute(
        process.execPath,
        [
          '--experimental-import-meta-resolve',
          '--input-type=module',
          '--eval',
          'console.log(import.meta.resolve(process.argv[1], process.argv[2]))',
          name,
          pathToFileURL(join(prefix, 'package.json')).href
        ],
        { shell: false }
      )
      resolvedModule = fileURLToPath(result.stdout.trim())
    }
    const entry: Entry = {
      module: spec.module,
      ...(spec.export === undefined ? {} : { export: spec.export }),
      ...(spec.config === undefined ? {} : { config: spec.config }),
      resolvedModule,
      enabled: false
    }
    next = [...previous, entry]
  } else if (request.action === 'remove') {
    next = previous.filter((item) => item.module !== request.module)
  } else if (request.action === 'enable') {
    if (!previous.some((item) => item.module === request.module)) throw new Error('Plugin is not installed')
    next = previous.map((item) => (item.module === request.module ? { ...item, enabled: request.enabled } : item))
  } else {
    throw new Error('Unknown plugin operation')
  }
  saveEntries(directory, next)
  return { previous, expected: next }
}

/** Optional fibers load after required/deployment services; one broken install cannot prevent boot. */
export function createDesktopComposition(directory?: string): HostCompositionFactory {
  return (options) => {
    const base = createNodeComposition(options)
    return {
      ...base,
      async setup(ctx) {
        await base.setup(ctx)
        if (!directory) return
        const diagnostics: Record<string, string> = {}
        for (const entry of readEntries(directory).filter((item) => item.enabled)) {
          const owned = ctx.plugin(async (child) => {
            await mountRuntimePlugin(child, { ...entry, module: pathToFileURL(entry.resolvedModule).href }, {
              importModule: specifier => import(/* @vite-ignore */ specifier)
            })
          })
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              owned,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Optional plugin activation timed out')), 5_000)
              })
            ])
          } catch (error) {
            diagnostics[entry.module] = error instanceof Error ? error.message : String(error)
            try {
              await owned.dispose()
            } catch (disposeError) {
              diagnostics[entry.module] +=
                `; cleanup: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`
            }
          } finally {
            clearTimeout(timer)
          }
        }
        mkdirSync(directory, { recursive: true })
        const path = join(directory, 'diagnostics.json')
        const temporary = `${path}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify(diagnostics), { mode: 0o600 })
        renameSync(temporary, path)
      }
    }
  }
}
