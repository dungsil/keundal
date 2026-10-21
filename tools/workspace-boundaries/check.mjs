import console from 'node:console'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import ts from 'typescript'

function isWithin(path, directory) {
  const child = relative(directory, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\'))
}

const groups = ['apps', 'packages', 'tools', 'examples']
const ignored = new Set(['node_modules', 'dist', 'target', 'coverage'])

async function* sources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignored.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|vue|json)$/.test(entry.name)) yield path
  }
}

function strings(source, file) {
  if (extname(file) === '.json') {
    const values = []
    function visit(value) {
      if (typeof value === 'string') values.push(value)
      else if (value && typeof value === 'object') Object.values(value).forEach(visit)
    }
    const parsed = ts.parseConfigFileTextToJson(file, source)
    if (parsed.error) throw new Error(`Cannot parse ${file}`)
    visit(parsed.config)
    if (/^tsconfig.*\.json$/.test(file.split(/[\\/]/).at(-1))) {
      const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dirname(file), undefined, file)
      const paths = Object.values(config.options.paths ?? {}).flat()
      const base = config.options.baseUrl ?? config.options.pathsBasePath ?? dirname(file)
      return [...values.filter((value) => !paths.includes(value)), ...paths.map((path) => resolve(base, path))]
    }
    return values
  }
  if (extname(file) === '.vue') {
    source = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script(?=[\t\n\f\r />])[^>]*>/gi)]
      .map((match) => match[1])
      .join('\n')
  }
  const values = []
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function visit(node) {
    if (ts.isStringLiteralLike(node)) values.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return values
}

export async function checkWorkspaceBoundaries(root) {
  const workspaces = []
  for (const group of groups) {
    const entries = await readdir(resolve(root, group), { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = resolve(root, group, entry.name)
      const manifest = await readFile(resolve(directory, 'package.json'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (manifest) workspaces.push({ directory, group, manifest: JSON.parse(manifest) })
    }
  }
  const apps = workspaces.filter((workspace) => workspace.group === 'apps')
  const errors = []
  for (const workspace of workspaces) {
    for await (const file of sources(workspace.directory)) {
      const source = await readFile(file, 'utf8')
      for (const value of strings(source, file)) {
        for (const app of apps) {
          if (app.directory === workspace.directory) continue
          const name = app.manifest.name
          const referencesName =
            name &&
            value
              .split(/[\s"'=]+/)
              .some(
                (part) =>
                  part === name ||
                  part.startsWith(`${name}/`) ||
                  part.startsWith(`${name}...`) ||
                  part.startsWith(`workspace:${name}@`) ||
                  part.startsWith(`npm:${name}@`)
              )
          const specifier = value.replace(/^(?:file:|link:|workspace:)/, '')
          const target = specifier.startsWith('.') || isAbsolute(specifier) ? resolve(dirname(file), specifier) : null
          const referencesPath = target && isWithin(target, app.directory)
          if (referencesName || referencesPath) {
            errors.push(`${relative(root, file)}: ${value} references app ${name}`)
          }
        }
      }
      if (file === resolve(workspace.directory, 'package.json')) {
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          for (const name of Object.keys(workspace.manifest[field] ?? {})) {
            const app = apps.find((candidate) => candidate.manifest.name === name)
            if (app && app.directory !== workspace.directory) {
              errors.push(`${relative(root, file)}: ${field}.${name} references app ${name}`)
            }
          }
        }
      }
    }
  }
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await checkWorkspaceBoundaries(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Workspace app boundaries passed.')
  }
}
