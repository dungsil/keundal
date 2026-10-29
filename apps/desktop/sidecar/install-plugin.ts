import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import type { RuntimePluginInfo, RuntimePluginSource } from '@keundal/chat/platform'
import { unzipSync } from 'fflate'
import { resolve as resolveModule } from 'import-meta-resolve'

import { readDshBundle } from './dsh-plugins.js'

export interface InstalledPlugin {
  module: string
  enabled: boolean
  source: RuntimePluginSource
  resolvedModule: string
  format?: 'dsh'
  metadata?: RuntimePluginInfo['metadata']
  version?: string
}

const exec = promisify(execFile)
const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*^~+<>=| -]+)?$/

export function validateSource(value: unknown): RuntimePluginSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin source')
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => key !== 'type' && key !== 'value') ||
    !['npm', 'jsr', 'zip', 'path'].includes(String(source.type)) || typeof source.value !== 'string' || !source.value.trim()) {
    throw new Error('Invalid plugin source')
  }
  const result = { type: source.type, value: source.value.trim() } as RuntimePluginSource
  if (result.type === 'npm' || result.type === 'jsr') {
    if (!packagePattern.test(result.value) || (result.type === 'jsr' && !result.value.startsWith('@'))) {
      throw new Error('Use a package name with an optional version, not a URL or command')
    }
  } else if (!isAbsolute(result.value)) throw new Error('Local plugin paths must be absolute')
  return result
}

function extractZip(path: string, destination: string): string {
  if (statSync(path).size > 50 * 1024 * 1024) throw new Error('Plugin ZIP exceeds 50 MiB')
  let total = 0
  let count = 0
  const files = unzipSync(readFileSync(path), { filter(file) {
    total += file.originalSize
    if (++count > 10_000 || total > 200 * 1024 * 1024) throw new Error('Plugin ZIP exceeds extraction limits')
    if (file.name.includes('\\') || file.name.startsWith('/') || file.name.includes(':') || file.name.split('/').includes('..')) {
      throw new Error('Unsafe path in plugin ZIP')
    }
    return true
  } })
  mkdirSync(destination, { recursive: true })
  // Write regular files only, never archive symlinks or permissions.
  for (const [name, data] of Object.entries(files)) {
    const path = join(destination, name)
    if (name.endsWith('/')) mkdirSync(path, { recursive: true })
    else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, data, { flag: 'wx' })
    }
  }
  if (existsSync(join(destination, 'package.json'))) return destination
  const roots = readdirSync(destination, { withFileTypes: true }).filter(entry => entry.name !== '__MACOSX')
  if (roots.length === 1 && roots[0].isDirectory() && existsSync(join(destination, roots[0].name, 'package.json'))) {
    return join(destination, roots[0].name)
  }
  throw new Error('Plugin ZIP must contain one package with package.json')
}

/** Install without importing code or running lifecycle scripts. Each package has its own dependency tree. */
export async function installPlugin(directory: string, input: unknown): Promise<InstalledPlugin> {
  const source = validateSource(input)
  const id = randomUUID()
  const root = join(directory, 'installed', id)
  mkdirSync(root, { recursive: true })
  try {
    let resolvedModule: string
    let format: 'dsh' | undefined
    let packageInfo: Record<string, unknown> = {}
    if (source.type === 'path' && statSync(source.value).isFile()) {
      if (!/\.(?:mjs|cjs|js)$/.test(source.value)) throw new Error('Local plugin files must be compiled JavaScript')
      resolvedModule = pathToFileURL(source.value).href
    } else {
      const target = source.type === 'zip' ? extractZip(source.value, join(root, 'archive'))
        : source.type === 'jsr' ? source.value.replace(/^@([^/]+)\/([^@]+)/, '@jsr/$1__$2')
        : source.value
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
      writeFileSync(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n@jsr:registry=https://npm.jsr.io/\n')
      const bundled = fileURLToPath(new URL('./npm/bin/npm-cli.js', import.meta.url))
      const cli = existsSync(bundled) ? bundled
        : join(dirname(createRequire(import.meta.url).resolve('desktop-npm/package.json')), 'bin/npm-cli.js')
      await exec(process.execPath, [cli, 'install', '--prefix', root, '--global=false', '--ignore-scripts', '--no-audit', '--no-fund', '--install-links', '--', target], {
        cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...process.env, NODE_ENV: 'production', npm_config_ignore_scripts: 'true' }
      })
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      const names = Object.keys(manifest.dependencies ?? {})
      if (names.length !== 1) throw new Error('Expected one installed plugin package')
      const packageRoot = join(root, 'node_modules', names[0])
      packageInfo = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
      if (readDshBundle(packageRoot, packageInfo)) {
        format = 'dsh'
        resolvedModule = pathToFileURL(packageRoot).href
      } else {
        resolvedModule = resolveModule(names[0], pathToFileURL(join(root, 'entry.mjs')).href)
      }
    }
    const name = typeof packageInfo.name === 'string' ? packageInfo.name : basename(source.value)
    const description = typeof packageInfo.description === 'string' ? packageInfo.description : ''
    return {
      module: `external:${id}`, enabled: false, source, resolvedModule,
      ...(format ? { format } : {}),
      metadata: { name: { en: name, ko: name }, description: { en: description, ko: description } },
      ...(typeof packageInfo.version === 'string' ? { version: packageInfo.version } : {})
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export function installedDirectory(directory: string, module: string): string {
  if (!/^external:[a-f0-9-]{36}$/.test(module)) throw new Error('Invalid external plugin identifier')
  return resolve(directory, 'installed', module.slice('external:'.length))
}
