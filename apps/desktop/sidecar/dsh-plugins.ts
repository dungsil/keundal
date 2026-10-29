import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { mountRuntimePlugin, type RuntimeModuleSpec } from '@keundal/plugin-runtime'
import { FiberState, type Context } from 'cordis'
import { resolve as resolveModule } from 'import-meta-resolve'
import { parseDocument } from 'yaml'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read composition data only. DSH profile edits and browser modules are not executed. */
export function readDshBundle(root: string, manifest: Record<string, unknown>): RuntimeModuleSpec[] | undefined {
  if (!record(manifest.dsh) || !Object.hasOwn(manifest.dsh, 'bundle')) return undefined
  const bundle = manifest.dsh.bundle
  if (!record(bundle) || typeof bundle.patch !== 'string' || !bundle.patch.trim() || isAbsolute(bundle.patch)) {
    throw new Error('DSH bundle.patch must be a package-relative YAML path')
  }
  const path = realpathSync(resolve(root, bundle.patch))
  const inside = relative(realpathSync(root), path)
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')) {
    throw new Error('DSH bundle patch must stay inside its package')
  }
  if (statSync(path).size > 1024 * 1024) throw new Error('DSH bundle patch exceeds 1 MiB')
  const document = parseDocument(readFileSync(path, 'utf8'))
  if (document.errors.length) throw new Error(`Invalid DSH bundle YAML: ${document.errors[0].message}`)
  const layers: unknown = document.toJS({ maxAliasCount: 100 })
  if (!Array.isArray(layers) || !layers.length) throw new Error('DSH bundle patch must contain insert layers')
  const specs: RuntimeModuleSpec[] = []
  const ids = new Set<string>()
  for (const layer of layers) {
    if (!record(layer) || Object.keys(layer).some(key => key !== 'insert') || !Array.isArray(layer.insert)) {
      throw new Error('Only DSH bundle insert layers are supported; profile edits are not supported')
    }
    for (const row of layer.insert) {
      if (!record(row) || Object.keys(row).some(key => !['id', 'name', 'config', 'disabled'].includes(key)) ||
        typeof row.name !== 'string' || !row.name.trim() ||
        (row.id !== undefined && (typeof row.id !== 'string' || !row.id.trim())) ||
        (row.disabled !== undefined && typeof row.disabled !== 'boolean') ||
        (row.config !== undefined && !record(row.config))) {
        throw new Error('Invalid or unsupported DSH bundle entry')
      }
      if (typeof row.id === 'string') {
        if (ids.has(row.id)) throw new Error(`Duplicate DSH bundle entry: ${row.id}`)
        ids.add(row.id)
      }
      if (row.disabled) continue
      specs.push({ module: row.name, ...(row.config === undefined ? {} : { config: row.config }) })
    }
  }
  if (!specs.length) throw new Error('DSH bundle has no enabled host entries')
  return specs
}

/** All rows belong to one fiber, including partial registrations on activation failure. */
export async function mountDshBundle(ctx: Context, root: string): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  const specs = readDshBundle(root, manifest)
  if (!specs) throw new Error('Installed package no longer declares a DSH bundle')
  const parent = pathToFileURL(join(root, 'package.json')).href
  const modules = new Map<string, Record<string, unknown>>()
  for (const spec of specs) {
    const url = resolveModule(spec.module, parent)
    const exports = await import(/* @vite-ignore */ url) as Record<string, unknown>
    // DSH packages commonly export { name, inject, Config, apply }, not default.
    modules.set(spec.module, Object.hasOwn(exports, 'default') ? exports : { default: exports })
  }
  const scope = ctx.plugin(async (owned: Context) => {
    const fibers = []
    for (const spec of specs) {
      fibers.push(await mountRuntimePlugin(owned, spec, { importModule: async name => modules.get(name)! }))
    }
    // A later row may provide an earlier row's injection. Check after every row is mounted.
    for (const fiber of fibers) await fiber.await()
    const pending = fibers.filter(fiber => fiber.state === FiberState.PENDING)
    if (pending.length) {
      throw new Error(`DSH host services unavailable: ${[...new Set(pending.flatMap(fiber => Object.keys(fiber.inject)))].join(', ')}`)
    }
    if (record(manifest.dsh) && manifest.dsh.client) {
      owned.logger.warn('DSH host bundle loaded; DSH React client modules are not supported and were not loaded')
    }
  })
  try {
    await scope
  } catch (error) {
    await scope.dispose()
    throw error
  }
}
