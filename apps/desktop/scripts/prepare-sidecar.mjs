import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = dirname(dirname(fileURLToPath(import.meta.url)))
const root = join(desktop, '..', '..')
const tauri = join(desktop, 'src-tauri')
const server = join(root, 'apps', 'server')
const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? /^host:\s*(.+)$/m.exec(output)?.[1]?.trim()
if (!triple) throw new Error('Could not determine the Rust target triple')

const resources = join(tauri, 'sidecar')
rmSync(resources, { recursive: true, force: true })
mkdirSync(resources, { recursive: true })
cpSync(join(server, 'dist'), resources, { recursive: true })

const binaries = join(tauri, 'binaries')
mkdirSync(binaries, { recursive: true })
const suffix = process.platform === 'win32' ? '.exe' : ''
const target = join(binaries, `keundal-host-${triple}${suffix}`)
copyFileSync(process.execPath, target)
if (process.platform !== 'win32') chmodSync(target, 0o755)
console.log(`Prepared sidecar ${target}`)
console.log(`Prepared resources ${resources}`)
