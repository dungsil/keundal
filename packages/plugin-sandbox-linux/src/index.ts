import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  closeSync,
  constants,
  type Dirent,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { SandboxProcessRequest, SandboxProvider } from '@keundal/sandbox'

const runtimePaths = ['/usr', '/bin', '/lib', '/lib64']
const bridgeTargets = new Set(['/run/keundal/worker.mjs', '/run/keundal/api.sock', '/run/keundal/network.sock'])
const broadPaths = new Set([
  '/',
  '/home',
  '/root',
  '/etc',
  '/var',
  '/opt',
  '/mnt',
  '/media',
  '/srv',
  '/boot',
  '/sys',
  '/proc',
  '/dev',
  '/run',
  '/tmp',
  ...runtimePaths
])

function within(path: string, parent: string): boolean {
  return parent === sep || path === parent || path.startsWith(`${parent}${sep}`)
}

function absolute(path: string): string {
  if (!isAbsolute(path) || path.includes('\0') || normalize(path) !== path) {
    throw new Error(`Sandbox paths must be normalized absolute paths: ${path}`)
  }
  return path
}

function grant(path: string): string {
  const resolved = realpathSync(absolute(path))
  if (
    broadPaths.has(resolved) ||
    ['/proc', '/dev', '/sys', '/run', ...runtimePaths].some((root) => within(resolved, root))
  ) {
    throw new Error(`Unsafe sandbox filesystem grant: ${path}`)
  }
  return resolved
}

// A bind mount also exposes inode authority, not just pathnames. Do not admit
// pre-existing host service sockets, devices, or aliases of outside regular files.
// Host-side publishers must not introduce such capabilities during execution.
function inspectTree(path: string, runtime: boolean, root = true): void {
  const entry = root ? statSync(path) : lstatSync(path)
  if (entry.isSymbolicLink()) return
  if (entry.isDirectory()) {
    let children: Dirent[]
    try {
      children = readdirSync(path, { withFileTypes: true })
    } catch (error) {
      // Root-owned, inaccessible system directories remain inaccessible after cap-drop.
      if (runtime && entry.uid !== process.getuid!() && (error as NodeJS.ErrnoException).code === 'EACCES') return
      throw error
    }
    for (const child of children) {
      // Trusted runtime files may have package-manager hardlinks. Directory entry
      // types already distinguish these files from sockets/devices, without one
      // extra stat syscall per file in a potentially very large OS installation.
      if (runtime && (child.isFile() || child.isSymbolicLink())) continue
      inspectTree(join(path, child.name), runtime, false)
    }
  } else if (!entry.isFile() || (!runtime && entry.nlink !== 1)) {
    throw new Error(`Unsafe sandbox file (special file or hardlink): ${path}`)
  }
}

/** Linux-only, fail-closed bubblewrap execution. No tool approval can widen these mounts. */
export class LinuxSandboxProvider implements SandboxProvider {
  readonly executable: string

  constructor(options: { executable?: string } = {}) {
    if (process.platform !== 'linux') {
      throw new Error('LinuxSandboxProvider requires Linux')
    }
    this.executable = absolute(options.executable ?? '/usr/bin/bwrap')
  }

  start(request: SandboxProcessRequest): ChildProcessWithoutNullStreams {
    // Sources and destinations use the same canonical path. In particular, a symlink
    // grant never turns into a mount over its alias or a grant of its parent directory.
    const workspace = grant(request.policy.workspace)
    if (workspace !== request.policy.workspace || !statSync(workspace).isDirectory()) {
      throw new Error('Sandbox workspace must be a canonical directory')
    }
    const executable = realpathSync(absolute(request.executable))
    if (!statSync(executable).isFile()) throw new Error('Sandbox executable must be a file')
    const args = [
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-net',
      '--unshare-uts',
      '--disable-userns',
      '--assert-userns-disabled',
      '--cap-drop',
      'ALL',
      '--new-session',
      '--die-with-parent',
      '--clearenv'
    ]
    // These are explicit, operator-authorized runtime trees, not a host-root bind.
    const runtime = runtimePaths.filter((path) => existsSync(path) && statSync(path).isDirectory())
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run')
    const paths = [
      ...(request.policy.readOnlyPaths ?? []).map((path) => ({ path: grant(path), writable: false })),
      ...(request.policy.writablePaths ?? []).map((path) => ({ path: grant(path), writable: true })),
      { path: workspace, writable: true }
    ].sort((a, b) => a.path.split(sep).length - b.path.split(sep).length)
    const protectedPaths = [
      dirname(fileURLToPath(import.meta.url)),
      executable,
      ...(existsSync(this.executable) ? [this.executable] : []),
      ...(request.protectedPaths ?? [])
    ].map((path) => realpathSync(absolute(path)))
    for (const { path, writable } of paths) {
      if (
        writable &&
        protectedPaths.some((protectedPath) => within(protectedPath, path) || within(path, protectedPath))
      ) {
        throw new Error(`Sandbox writable grant overlaps trusted parent files: ${path}`)
      }
      args.push(writable ? '--bind' : '--ro-bind', path, path)
    }
    // Grant paths cannot overlap runtime roots. Inspect grants first so a rejected
    // workspace never pays for traversing the entire system runtime installation.
    for (const path of runtime) args.push('--ro-bind', path, path)
    if (!runtime.some((path) => within(executable, realpathSync(path)))) {
      // Resolve pnpm's Node symlink, then expose only the executable, not its tree.
      grant(executable)
      args.push('--ro-bind', executable, executable)
    }
    const mountedTargets = new Set<string>()
    for (const mount of request.mounts) {
      if (mount.writable || !bridgeTargets.has(mount.target) || mountedTargets.has(mount.target)) {
        throw new Error('Host bridge mounts must be read-only, distinct, fixed bridge targets')
      }
      mountedTargets.add(mount.target)
      const source = grant(mount.source)
      if (source !== mount.source) throw new Error('Host bridge source must be canonical')
      const sourceStat = statSync(source)
      if (mount.target.endsWith('.sock') ? !sourceStat.isSocket() : !sourceStat.isFile()) {
        throw new Error('Host bridge source must match its file or Unix socket target')
      }
      args.push('--ro-bind', source, mount.target)
    }
    const mountsEnd = args.length
    for (const [name, value] of Object.entries(request.environment)) {
      if (!name || name.includes('=') || name.includes('\0') || value.includes('\0')) {
        throw new Error('Invalid sandbox environment entry')
      }
      args.push('--setenv', name, value)
    }
    args.push('--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin')
    args.push('--chdir', workspace, '--', executable, ...request.args)
    // Pin mount sources before spawn: another sandbox sharing the workspace must
    // not swap a validated grant for a symlink to an ungranted host directory.
    const descriptors: number[] = []
    const inspected = new Set<string>()
    try {
      for (let index = 0; index < mountsEnd; index++) {
        if (args[index] !== '--bind' && args[index] !== '--ro-bind') continue
        const source = realpathSync(args[index + 1]!)
        const expected = args[index + 1]!
        // The fixed runtime aliases (/bin, /lib, /lib64) are operator-owned.
        if (source !== expected && !runtime.includes(expected)) {
          throw new Error(`Sandbox mount source changed: ${expected}`)
        }
        // O_PATH is Linux-only and supports Unix sockets without connecting to them.
        const descriptor = openSync(source, 0x200000 | constants.O_NOFOLLOW)
        descriptors.push(descriptor)
        if (realpathSync(`/proc/self/fd/${descriptor}`) !== source) {
          throw new Error(`Sandbox mount source changed: ${source}`)
        }
        if (!bridgeTargets.has(args[index + 2]!) && !inspected.has(source)) {
          inspectTree(`/proc/self/fd/${descriptor}`, runtime.includes(expected) || source === executable)
          inspected.add(source)
        }
        args[index] = args[index] === '--bind' ? '--bind-fd' : '--ro-bind-fd'
        args[index + 1] = String(2 + descriptors.length)
        index += 2
      }
      return spawn(this.executable, args, {
        env: {},
        stdio: ['pipe', 'pipe', 'pipe', ...descriptors],
        detached: false,
        shell: false
      }) as ChildProcessWithoutNullStreams
    } finally {
      for (const descriptor of descriptors) closeSync(descriptor)
    }
  }
}
