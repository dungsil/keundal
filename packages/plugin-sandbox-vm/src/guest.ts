import { Buffer } from 'node:buffer'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream, openSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute, join, posix } from 'node:path'
import process from 'node:process'
import { clearTimeout, setInterval, setTimeout } from 'node:timers'

import { LineChannel } from './protocol.js'

// This program is PID 1 inside the guest, never a host-side executable.
type Root = { id: number; target: string; writable: boolean; store: string }
type Entry = {
  root: Root
  path: string
  kind: 'directory' | 'file' | 'symlink' | 'delete'
  mode: number
  base: string | null
  hash: string | null
  stage: string
  target?: string
}
const control = '/dev/virtio-ports/keundal.control'
// virtio-serial ports allow only one open. Share a single O_RDWR descriptor.
const descriptor = openSync(control, 'r+')
const input = createReadStream(control, { fd: descriptor, autoClose: false })
const output = createWriteStream(control, { fd: descriptor, autoClose: false })
const channel = new LineChannel(input, output)
const roots = new Map<number, Root>()
const entries: Entry[] = []
const seen = new Set<string>()
const sockets = new Map<number, Socket>()
const servers: Server[] = []
let nextSocket = 1
let worker: ChildProcess | undefined
let workerOutput: Promise<unknown> | undefined
let configured = false
let running = false
let stopping = false
let connected = true
let shutdownTask: Promise<void> | undefined
let acknowledge: (() => void) | undefined
let awaitingAcknowledgement = false
let exportRejected = false
let staging = ''
let active: { entry: Entry; file: fs.FileHandle; hash: ReturnType<typeof createHash> } | undefined
let configuration: Record<string, unknown>

function fail(): never {
  throw new Error('Invalid guest operation')
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) fail()
  return value
}
function hashValue(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail()
  return value
}
function relative(value: unknown): string {
  const path = string(value)
  if (!path || isAbsolute(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) fail()
  return path
}
function decode(value: unknown): Buffer {
  const data = string(value)
  if (data.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail()
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > 65536) fail()
  return bytes
}
async function stat(path: string) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
// Every traversal is lstat-based. The worker is stopped throughout import/export.
async function safePath(root: string, path: string): Promise<string> {
  let current = root
  const parts = path.split('/')
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    const info = await stat(current)
    if (info && !info.isDirectory()) fail()
  }
  return join(root, path)
}
async function digest(path: string): Promise<string | null> {
  const info = await stat(path)
  if (!info || info.isDirectory()) return null
  if (info.isSymbolicLink())
    return createHash('sha256')
      .update('symlink:' + (await fs.readlink(path)))
      .digest('hex')
  if (!info.isFile() || info.nlink !== 1) fail()
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function command(program: string, args: string[]) {
  const result = spawnSync(program, args, { stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/sbin' } })
  if (result.status !== 0) fail()
}
async function configure(frame: Record<string, unknown>) {
  if (configured || !Array.isArray(frame.roots) || frame.roots.length > 256) fail()
  configuration = frame
  await fs.mkdir('/run/keundal', { recursive: true, mode: 0o755 })
  // Stage on disk, not the 1 GiB guest's tmpfs. Only PID 1 can access /state.
  for (const name of await fs.readdir('/state')) {
    if (/^\.keundal-import-[A-Za-z0-9]+$/.test(name)) await fs.rm(`/state/${name}`, { recursive: true, force: true })
  }
  staging = await fs.mkdtemp('/state/.keundal-import-')
  await fs.chmod(staging, 0o700)
  await fs.mkdir('/state/roots', { recursive: true, mode: 0o700 })
  const reserved = [
    '/proc',
    '/sys',
    '/dev',
    '/run',
    '/state',
    '/bin',
    '/sbin',
    '/usr',
    '/lib',
    '/lib64',
    '/etc',
    '/modules',
    '/modules.load',
    '/init',
    '/guest.mjs',
    '/prepare-state.mjs'
  ]
  for (const value of frame.roots) {
    if (!value || typeof value !== 'object') fail()
    const item = value as Record<string, unknown>
    const target = string(item.target)
    if (
      !Number.isSafeInteger(item.id) ||
      (item.id as number) < 0 ||
      roots.has(item.id as number) ||
      typeof item.writable !== 'boolean'
    )
      fail()
    if (
      !isAbsolute(target) ||
      posix.normalize(target) !== target ||
      target === '/' ||
      target === '/tmp' ||
      target.endsWith('/')
    )
      fail()
    const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
    if (
      reserved.some((path) => overlaps(path, target)) ||
      [...roots.values()].some((root) => overlaps(root.target, target))
    )
      fail()
    const store = `/state/roots/${item.id}`
    const prior = await stat(store)
    if (prior && !prior.isDirectory()) fail()
    await fs.mkdir(store, { recursive: true, mode: 0o700 })
    await fs.chown(store, 1000, 1000)
    roots.set(item.id as number, { id: item.id as number, target, writable: item.writable, store })
  }
  string(frame.workspace)
  string(frame.workerSource)
  if (!Array.isArray(frame.args) || !frame.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) fail()
  if (!frame.environment || typeof frame.environment !== 'object' || Array.isArray(frame.environment)) fail()
  for (const [key, value] of Object.entries(frame.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail()
    string(value)
  }
  configured = true
}
async function entry(frame: Record<string, unknown>) {
  if (!configured || running || stopping || active) fail()
  const root = roots.get(frame.root as number)
  if (!root) fail()
  const path = relative(frame.path)
  const key = `${root.id}/${path}`
  if (seen.has(key) || entries.length >= 1_000_000) fail()
  seen.add(key)
  const kind = frame.type === 'delete' ? 'delete' : frame.kind
  if (kind !== 'directory' && kind !== 'file' && kind !== 'symlink' && kind !== 'delete') fail()
  if (
    kind !== 'delete' &&
    (!Number.isInteger(frame.mode) || (frame.mode as number) < 0 || (frame.mode as number) > 0o177777)
  )
    fail()
  const item: Entry = {
    root,
    path,
    kind,
    mode: (frame.mode as number) & 0o777,
    base: hashValue(frame.baseHash ?? null),
    hash: null,
    stage: `${staging}/${entries.length}`
  }
  entries.push(item)
  if (kind === 'file') {
    active = { entry: item, file: await fs.open(item.stage, 'wx', 0o600), hash: createHash('sha256') }
  } else if (kind === 'symlink') {
    item.target = string(frame.target)
    item.hash = createHash('sha256')
      .update('symlink:' + item.target)
      .digest('hex')
    await fs.symlink(item.target, item.stage)
  }
}
async function merge() {
  if (!configured || running || active || stopping) fail()
  const changes: Entry[] = []
  // Plan every conflict before touching persistent data. A disconnected import never merges.
  for (const item of entries) {
    const path = await safePath(item.root.store, item.path)
    const current = await digest(path)
    const info = await stat(path)
    const sameKind =
      item.kind === 'delete'
        ? !info
        : item.kind === 'directory'
          ? info?.isDirectory()
          : item.kind === 'file'
            ? info?.isFile()
            : info?.isSymbolicLink()
    if (current === item.hash && sameKind) continue
    if (current === item.base) changes.push(item)
    else if (item.hash !== item.base) throw new Error('Persistent VM data conflicts with imported snapshot')
  }
  // An imported symlink/file must never become another entry's ancestor.
  const changed = new Map(changes.map((item) => [`${item.root.id}/${item.path}`, item]))
  for (const item of changes) {
    if (item.kind === 'delete') continue
    const parts = item.path.split('/')
    for (let length = 1; length < parts.length; length++) {
      const ancestor = changed.get(`${item.root.id}/${parts.slice(0, length).join('/')}`)
      if (ancestor && ancestor.kind !== 'directory') fail()
    }
  }
  const removals = changes
    .filter((item) => item.kind === 'delete')
    .sort((a, b) => b.path.split('/').length - a.path.split('/').length)
  const removed = new Set(removals.map((item) => `${item.root.id}/${item.path}`))
  for (const item of changes) {
    const path = await safePath(item.root.store, item.path)
    if (item.kind !== 'directory' && (await stat(path))?.isDirectory()) {
      // Reject nonempty-directory conflicts before applying *any* changes.
      for (const child of await fs.readdir(path)) {
        if (!removed.has(`${item.root.id}/${item.path}/${child}`))
          throw new Error('Persistent directory contains unsynced VM data')
      }
    }
  }
  for (const item of removals) {
    const path = await safePath(item.root.store, item.path)
    const info = await stat(path)
    if (info?.isDirectory()) await fs.rmdir(path) // Never recursively erase unsynced guest children.
    else if (info) await fs.unlink(path)
  }
  for (const item of changes
    .filter((item) => item.kind !== 'delete')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const path = await safePath(item.root.store, item.path)
    // Parents must have explicit directory entries, not implicit symlink-following mkdir.
    if (!(await stat(dirname(path)))?.isDirectory()) fail()
    const info = await stat(path)
    if (item.kind === 'directory') {
      if (info && !info.isDirectory()) await fs.unlink(path)
      await fs.mkdir(path, { recursive: true, mode: 0o700 })
    } else {
      if (info?.isDirectory()) await fs.rmdir(path)
      // Publish content and safe metadata atomically within the persistent fs.
      if (item.kind === 'symlink') await fs.lchown(item.stage, 1000, 1000)
      else {
        await fs.chown(item.stage, 1000, 1000)
        await fs.chmod(item.stage, item.mode)
      }
      await fs.rename(item.stage, path)
    }
    if (item.kind === 'symlink') await fs.lchown(path, 1000, 1000)
    else {
      await fs.chown(path, 1000, 1000)
      await fs.chmod(path, item.mode)
    }
  }
  command('/bin/sync', [])
  await fs.rm(staging, { recursive: true })
  entries.length = 0
  seen.clear()
}

async function pump(source: NodeJS.ReadableStream, type: 'stdout' | 'stderr') {
  for await (const value of source) {
    const bytes = Buffer.from(value)
    for (let offset = 0; offset < bytes.length; offset += 65536)
      await channel.send({ type, data: bytes.subarray(offset, offset + 65536).toString('base64') })
  }
}
async function bridge(name: 'api' | 'network') {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (stopping || sockets.size >= 64 || nextSocket >= Number.MAX_SAFE_INTEGER) return socket.destroy()
    const id = nextSocket++
    sockets.set(id, socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      // Hold the slot until its close frame drains: connection churn cannot build
      // an unbounded queue behind the single backpressured control writer.
      void (async () => {
        try {
          if (connected && !stopping) await channel.send({ type: 'close', id })
        } finally {
          sockets.delete(id)
        }
      })().catch(() => stop(false))
    })
    void (async () => {
      await channel.send({ type: 'open', id, channel: name })
      for await (const bytes of socket) {
        const data = Buffer.from(bytes)
        for (let offset = 0; offset < data.length; offset += 65536)
          await channel.send({ type: 'data', id, data: data.subarray(offset, offset + 65536).toString('base64') })
      }
      if (!stopping) await channel.send({ type: 'end', id })
    })().catch(() => socket.destroy())
  })
  servers.push(server)
  server.listen(`/run/keundal/${name}.sock`)
  await once(server, 'listening')
  await fs.chmod(`/run/keundal/${name}.sock`, 0o600)
  await fs.chown(`/run/keundal/${name}.sock`, 1000, 1000)
}
async function launch() {
  await merge()
  for (const root of roots.values()) {
    const target = await safePath('/', relative(root.target.slice(1)))
    const existing = await stat(target)
    if (existing && (!existing.isDirectory() || existing.uid !== 0 || (await fs.readdir(target)).length)) fail()
    // Validate *all* ancestors, including existing system directories.
    await fs.mkdir(target, { recursive: true, mode: 0o755 })
    command('/bin/mount', ['--bind', root.store, target])
    if (!root.writable) command('/bin/mount', ['-o', 'remount,bind,ro,nosuid,nodev', target])
    else command('/bin/mount', ['-o', 'remount,bind,rw,nosuid,nodev', target])
  }
  const workspace = string(configuration.workspace)
  const workspaceRoot = [...roots.values()].find(
    (root) => workspace === root.target || workspace.startsWith(root.target + '/')
  )
  if (!workspaceRoot || posix.normalize(workspace) !== workspace) fail()
  if (workspace !== workspaceRoot.target)
    await safePath(workspaceRoot.target, relative(workspace.slice(workspaceRoot.target.length + 1)) + '/_')
  if (!(await stat(workspace))?.isDirectory()) fail()
  await fs.writeFile('/run/keundal/worker.mjs', string(configuration.workerSource), { mode: 0o444 })
  await bridge('api')
  await bridge('network')
  running = true
  await channel.send({ type: 'imported' })
  worker = spawn('/bin/busybox', ['setpriv', '--no-new-privs', '/usr/bin/node', ...(configuration.args as string[])], {
    uid: 1000,
    gid: 1000,
    cwd: workspace,
    env: {
      HOME: '/tmp',
      TMPDIR: '/tmp',
      ...(configuration.environment as Record<string, string>),
      PATH: '/usr/bin:/bin'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  workerOutput = Promise.all([pump(worker.stdout!, 'stdout'), pump(worker.stderr!, 'stderr')])
  workerOutput.catch(() => stop(false))
  worker.once('error', () => {
    void fatal()
  })
  worker.once('exit', (code) => {
    // Do not wait for inherited stdout pipes: a detached descendant may own them.
    if (!stopping) void stop(true, code ?? 1)
  })
}
async function userProcesses(): Promise<number[]> {
  const result: number[] = []
  for (const id of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(id)) continue
    try {
      const status = await fs.readFile(`/proc/${id}/status`, 'utf8')
      if (/^Uid:\s+1000\s/m.test(status) && !/^State:\s+Z/m.test(status)) result.push(Number(id))
    } catch {
      /* Process exited during enumeration. */
    }
  }
  return result
}
async function terminate() {
  const signal = async (name: NodeJS.Signals) => {
    for (const pid of await userProcesses()) {
      try {
        process.kill(pid, name)
      } catch {
        /* Already exited. */
      }
    }
  }
  await signal('SIGTERM')
  const deadline = Date.now() + 5000
  while ((await userProcesses()).length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100))
  for (let round = 0; round < 20; round++) {
    await signal('SIGKILL')
    if (!(await userProcesses()).length) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  fail() // No snapshot while a workload can still mutate it.
}
async function exportRoot(root: Root, path = ''): Promise<void> {
  const directory = path ? await safePath(root.store, path) : root.store
  for (const name of (await fs.readdir(directory)).sort()) {
    if (exportRejected) throw new Error('VM export rejected')
    const child = path ? `${path}/${name}` : name
    relative(child)
    const absolute = await safePath(root.store, child)
    const info = await fs.lstat(absolute)
    if (info.isSocket()) continue // Plugin Unix sockets carry authority, never transfer them.
    if (info.isDirectory()) {
      await channel.send({
        type: 'entry',
        root: root.id,
        path: child,
        kind: 'directory',
        mode: info.mode & 0o777,
        baseHash: null
      })
      await exportRoot(root, child)
    } else if (info.isSymbolicLink()) {
      await channel.send({
        type: 'entry',
        root: root.id,
        path: child,
        kind: 'symlink',
        mode: 0o777,
        target: await fs.readlink(absolute),
        baseHash: null
      })
    } else if (info.isFile() && info.nlink === 1) {
      await channel.send({
        type: 'entry',
        root: root.id,
        path: child,
        kind: 'file',
        mode: info.mode & 0o777,
        baseHash: null
      })
      const hash = createHash('sha256')
      for await (const bytes of createReadStream(absolute, { highWaterMark: 65536 })) {
        if (exportRejected) throw new Error('VM export rejected')
        hash.update(bytes)
        await channel.send({ type: 'chunk', data: bytes.toString('base64') })
      }
      await channel.send({ type: 'file-end', hash: hash.digest('hex') })
    } else throw new Error('Unsupported persistent file type')
  }
}
function poweroff() {
  spawnSync('/bin/sync', [], { stdio: 'ignore' })
  for (const root of [...roots.values()].reverse()) spawnSync('/bin/umount', [root.target], { stdio: 'ignore' })
  spawnSync('/bin/umount', ['/state'], { stdio: 'ignore' })
  spawnSync('/bin/poweroff', ['-f'], { stdio: 'ignore' })
  // PID 1 must never exit, even if reboot(2) unexpectedly fails.
  setInterval(() => {}, 60_000)
}
function stop(exportData: boolean, exitCode?: number): Promise<void> {
  if (shutdownTask) return shutdownTask
  stopping = true
  shutdownTask = (async () => {
    try {
      await terminate()
      for (const server of servers) server.close()
      for (const socket of sockets.values()) socket.destroy()
      // Preserve generated bytes even if the host rejects the first export frame.
      spawnSync('/bin/sync', [], { stdio: 'ignore' })
      if (connected) await workerOutput
      if (exportData && connected && running && !exportRejected) {
        // Install the acknowledgement before the last frame can reach the parent.
        const ack = new Promise<void>((resolve) => {
          acknowledge = resolve
        })
        for (const root of roots.values()) if (root.writable) await exportRoot(root)
        if (exportRejected) throw new Error('VM export rejected')
        awaitingAcknowledgement = true
        await channel.send({ type: 'snapshot-end' })
        if (exitCode !== undefined) await channel.send({ type: 'worker-exit', code: exitCode })
        await ack
      }
    } catch {
      if (connected && !exportRejected) {
        try {
          await channel.send({ type: 'fatal', message: 'VM export failed; persistent data retained' })
        } catch {
          /* Transport closed. */
        }
      }
    } finally {
      poweroff()
    }
  })()
  shutdownTask.catch(() => {})
  return shutdownTask
}
async function fatal() {
  try {
    await channel.send({ type: 'fatal', message: 'VM guest operation failed; persistent data retained' })
  } catch {
    /* Transport is gone. */
  }
  await stop(false)
}
async function receive(frame: Record<string, unknown>) {
  if (frame.type === 'exported' && awaitingAcknowledgement) {
    acknowledge?.()
    return
  }
  if (frame.type === 'export-failed') {
    // Unwind an in-progress export instead of joining its blocked shutdown task.
    exportRejected = true
    acknowledge?.()
    if (!shutdownTask) void stop(false)
    return
  }
  if (frame.type === 'shutdown') {
    void stop(true)
    return
  }
  if (stopping) return
  switch (frame.type) {
    case 'configure':
      await configure(frame)
      break
    case 'entry':
    case 'delete':
      await entry(frame)
      break
    case 'chunk': {
      if (!active) fail()
      const bytes = decode(frame.data)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await active.file.write(bytes.subarray(offset))
        if (!bytesWritten) fail()
        offset += bytesWritten
      }
      active.hash.update(bytes)
      break
    }
    case 'file-end':
      if (!active || active.hash.digest('hex') !== hashValue(frame.hash)) fail()
      await active.file.close()
      active.entry.hash = frame.hash as string
      active = undefined
      break
    case 'snapshot-end':
      await launch()
      break
    case 'data': {
      if (!running || !Number.isSafeInteger(frame.id)) fail()
      const socket = sockets.get(frame.id as number)
      const bytes = decode(frame.data)
      if (socket && !socket.destroyed)
        await new Promise<void>((resolve) => {
          // One unresponsive worker connection must not indefinitely block a
          // shutdown or transport EOF behind its pending write.
          const timer = setTimeout(() => {
            socket.destroy()
            resolve()
          }, 5000)
          socket.write(bytes, (error) => {
            clearTimeout(timer)
            if (error) socket.destroy()
            resolve()
          })
        })
      break
    }
    case 'end':
      sockets.get(frame.id as number)?.end()
      break
    case 'close':
      sockets.get(frame.id as number)?.destroy()
      break
    default:
      fail()
  }
}
process.on('SIGTERM', () => {
  void stop(true)
})
process.on('SIGINT', () => {
  void stop(true)
})
output.on('error', () => {
  connected = false
  acknowledge?.()
  void stop(false)
})
try {
  if (process.pid !== 1 || process.getuid?.() !== 0) fail()
  await channel.send({ type: 'boot' })
  for await (const frame of channel.frames) await receive(frame)
  connected = false
  acknowledge?.()
  await stop(false)
} catch {
  connected = false
  acknowledge?.()
  await fatal()
}
