import type { SandboxProcessRequest } from '@keundal/sandbox'

import type { LinuxVmOptions } from './index.js'
import type { LineChannel } from './protocol.js'

/** Self-contained trusted launcher, serialized into a fresh Node process by the provider. */
export async function supervise(Channel: typeof LineChannel): Promise<void> {
  const process = globalThis.process
  const { Buffer } = process.getBuiltinModule('node:buffer')
  const console = process.getBuiltinModule('node:console')
  const { setTimeout, clearTimeout } = process.getBuiltinModule('node:timers')
  const unavailable = new Set<NodeJS.WriteStream>()
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => unavailable.add(stream))
  const print = (stream: NodeJS.WriteStream, bytes: Uint8Array) =>
    new Promise<void>((resolve) => {
      if (!process.connected || unavailable.has(stream)) return resolve()
      const timer = setTimeout(() => {
        unavailable.add(stream)
        resolve()
      }, 1000)
      stream.write(bytes, (error) => {
        clearTimeout(timer)
        if (error) unavailable.add(stream)
        resolve()
      })
    })
  const diagnostics = (source: import('node:stream').Readable) => {
    void (async () => {
      for await (const bytes of source) await print(process.stderr, Buffer.from(bytes))
    })().catch(() => {})
  }
  const configured = new Promise<{ options: LinuxVmOptions; request: SandboxProcessRequest }>((resolve) =>
    process.once('message', resolve)
  )
  // Synchronous built-ins survive serialization without bundler/Vite import helpers.
  const { spawn, spawnSync } = process.getBuiltinModule('node:child_process')
  const { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile, access, link } =
    process.getBuiltinModule('node:fs/promises')
  const { createHash } = process.getBuiltinModule('node:crypto')
  const { connect } = process.getBuiltinModule('node:net')
  const { dirname, isAbsolute, join, sep, toNamespacedPath } = process.getBuiltinModule('node:path')
  const input = await configured
  const { options, request } = input
  const within = (path: string, root: string) => {
    if (process.platform === 'win32') {
      path = path.toLowerCase()
      root = root.toLowerCase()
    }
    return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  }
  const roots: { id: number; path: string; target: string; writable: boolean }[] = []
  for (const entry of [
    { path: request.policy.workspace, writable: true },
    ...(request.policy.readOnlyPaths ?? []).map((path) => ({ path, writable: false })),
    ...(request.policy.writablePaths ?? []).map((path) => ({ path, writable: true }))
  ]) {
    if (!isAbsolute(entry.path)) throw new Error('VM grants must be absolute directories')
    const path = await realpath(entry.path)
    if (!(await stat(path)).isDirectory() || dirname(path) === path)
      throw new Error('VM grants must be bounded directories')
    if (roots.some((root) => within(path, root.path) || within(root.path, path)))
      throw new Error('VM grants must be disjoint directories')
    const target = process.platform === 'win32' ? `/workspaces/${roots.length}` : path
    if (
      ['/state', '/run', '/proc', '/sys', '/dev', '/usr', '/bin', '/lib', '/lib64', '/etc'].some(
        (root) => target === root || target.startsWith(root + '/')
      )
    ) {
      throw new Error('VM grant overlaps guest runtime or control files')
    }
    roots.push({ id: roots.length, path, target, writable: entry.writable })
  }
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  const stateRoot = await realpath(options.stateDirectory)
  const protectedPaths = await Promise.all(
    [
      stateRoot,
      options.qemu,
      options.qemuImg,
      options.kernel,
      options.initramfs,
      options.fileBroker,
      process.execPath,
      ...(request.protectedPaths ?? [])
    ].map((path) => realpath(path))
  )
  for (const root of roots) {
    if (
      within(stateRoot, root.path) ||
      within(root.path, stateRoot) ||
      (root.writable && protectedPaths.some((path) => within(path, root.path) || within(root.path, path)))
    ) {
      throw new Error('VM grant overlaps trusted launcher assets or state')
    }
  }
  const identity = createHash('sha256').update(JSON.stringify(roots)).digest('hex')
  const state = join(stateRoot, identity)
  await mkdir(state, { recursive: true, mode: 0o700 })
  const operation = await mkdtemp(join(state, 'transfer-'))
  const config = join(operation, 'broker.json')
  const baseline = join(state, 'baseline.json')
  const nextBaseline = join(operation, 'next-baseline.json')
  await mkdir(join(operation, 'staging'), { mode: 0o700 })
  await writeFile(
    config,
    JSON.stringify({
      roots: roots.map((root) => ({ ...root, path: toNamespacedPath(root.path) })),
      baseline,
      nextBaseline,
      staging: toNamespacedPath(join(operation, 'staging'))
    }),
    { mode: 0o600 }
  )
  const disk = join(state, 'workspace.qcow2')
  try {
    await access(disk)
  } catch {
    const initial = join(operation, 'initial.qcow2')
    const created = spawnSync(options.qemuImg, ['create', '-f', 'qcow2', initial, '8G'], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (created.error || created.status !== 0) throw new Error('Cannot create private VM disk')
    try {
      await link(initial, disk)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await rm(initial)
  }
  // A killed HTTP parent may leave its supervisor finishing a safe export. Wait
  // for QEMU's actual image lock rather than importing over a still-running disk.
  const deadline = Date.now() + 125_000
  for (;;) {
    const probe = spawnSync(options.qemuImg, ['info', disk], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' }
    })
    if (probe.status === 0) break
    if (!probe.stderr?.includes('lock') || Date.now() >= deadline)
      throw new Error('Private VM disk is unavailable or already in use')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!process.connected) throw new Error('VM parent disconnected before launch')
  const vm = spawn(
    options.qemu,
    [
      '-display',
      'none',
      '-monitor',
      'none',
      '-serial',
      'none',
      '-nodefaults',
      '-machine',
      'q35',
      '-cpu',
      'max',
      '-accel',
      'tcg',
      '-m',
      '1024',
      '-no-reboot',
      '-kernel',
      options.kernel,
      '-initrd',
      options.initramfs,
      '-append',
      'console=null panic=1',
      '-blockdev',
      JSON.stringify({
        driver: 'file',
        filename: disk,
        'node-name': 'disk-file',
        cache: { direct: true, 'no-flush': false }
      }),
      '-blockdev',
      JSON.stringify({ driver: 'qcow2', file: 'disk-file', 'node-name': 'disk' }),
      '-device',
      'virtio-blk-pci,drive=disk',
      '-device',
      'virtio-serial-pci',
      '-chardev',
      'stdio,id=control,signal=off',
      '-device',
      'virtserialport,chardev=control,name=keundal.control',
      '-nic',
      'none'
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  )
  diagnostics(vm.stderr)
  const channel = new Channel(vm.stdout, vm.stdin)
  const sockets = new Map<number, ReturnType<typeof connect>>()
  let transfer: ReturnType<typeof spawn> | undefined
  let transferExit: Promise<unknown> | undefined
  let shuttingDown = false
  let importing = false
  let booted = false
  let imported = false
  let exporting = false
  let exported = false
  let exitCode = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let failing = false
  const fail = () => {
    if (failing) return
    failing = true
    exitCode = 1
    for (const socket of sockets.values()) socket.destroy()
    // Let PID 1 sync generated data even when host export is rejected.
    void channel.send({ type: 'export-failed' }).catch(() => vm.stdin.end())
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      transfer?.kill('SIGKILL')
      vm.kill('SIGKILL')
    }, 30_000)
  }
  const shutdown = () => {
    if (shuttingDown || failing) return
    shuttingDown = true
    for (const socket of sockets.values()) socket.destroy()
    void channel.send({ type: 'shutdown' }).catch(() => vm.kill())
    timer = setTimeout(() => {
      exitCode = 1
      transfer?.kill('SIGKILL')
      vm.kill('SIGKILL')
    }, 120_000)
  }
  process.on('message', (message) => {
    if ((message as { type?: string })?.type === 'shutdown') shutdown()
  })
  process.once('disconnect', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  vm.once('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  const closed = new Promise<void>((resolve) =>
    vm.once('close', (code) => {
      if (code !== 0) exitCode = 1
      resolve()
    })
  )
  const translate = (value: string) => {
    const root = roots.find((root) => within(value, root.path))
    return root ? root.target + value.slice(root.path.length).split(sep).join('/') : value
  }
  const environment = { ...request.environment }
  for (const key of ['KEUNDAL_SQLITE_PATH', 'KEUNDAL_PLUGIN_CONFIG', 'KEUNDAL_MANAGED_PLUGINS']) {
    if (environment[key] && isAbsolute(environment[key])) environment[key] = translate(environment[key]!)
  }
  const endpoints = new Map(request.mounts.map((mount) => [mount.target, mount]))
  const worker = endpoints.get('/run/keundal/worker.mjs')
  if (!worker || worker.writable || endpoints.size !== 3 || request.mounts.some((mount) => mount.writable)) {
    vm.kill()
    throw new Error('VM requires the fixed, read-only worker and bridge endpoints')
  }
  try {
    for await (const frame of channel.frames) {
      // Keep draining serial after rejection so the guest can unwind a pending
      // write, sync its private disk and power off without the force-kill timer.
      if (failing) continue
      try {
        if (frame.type === 'boot') {
          if (booted) throw new Error('Duplicate VM boot acknowledgement')
          booted = true
          await channel.send({
            type: 'configure',
            roots: roots.map(({ id, target, writable }) => ({ id, target, writable })),
            workspace: roots[0]!.target,
            environment,
            args: request.args,
            workerSource: await readFile(worker.source, 'utf8')
          })
          transfer = spawn(options.fileBroker, ['snapshot', config], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          })
          diagnostics(transfer.stderr!)
          transferExit = new Promise<void>((resolve, reject) => {
            transfer!.once('error', reject)
            transfer!.once('close', (code) =>
              code === 0 ? resolve() : reject(new Error('VM import rejected by file broker'))
            )
          })
          // Consume rejection immediately, while serial output is still being forwarded.
          void transferExit.catch(fail)
          const entries = new Channel(transfer.stdout!, vm.stdin)
          importing = true
          for await (const entry of entries.frames) await channel.send(entry)
          await transferExit
        } else if (frame.type === 'imported') {
          if (!importing || imported) throw new Error('Unexpected VM import acknowledgement')
          importing = false
          await rename(nextBaseline, baseline)
          imported = true
        } else if (frame.type === 'stdout' || frame.type === 'stderr') {
          if (typeof frame.data !== 'string' || frame.data.length > 131072) throw new Error('Invalid VM output')
          const output = frame.type === 'stdout' ? process.stdout : process.stderr
          await print(output, Buffer.from(frame.data, 'base64'))
        } else if (frame.type === 'open') {
          const id = frame.id
          if (
            !Number.isSafeInteger(id) ||
            (id as number) <= 0 ||
            sockets.has(id as number) ||
            sockets.size >= 64 ||
            !['api', 'network'].includes(frame.channel as string)
          )
            throw new Error('Invalid VM bridge connection')
          const endpoint = endpoints.get(`/run/keundal/${frame.channel}.sock`)
          if (!endpoint) throw new Error('Missing VM bridge endpoint')
          const socket = connect(endpoint.source)
          sockets.set(id as number, socket)
          socket.on('error', () => socket.destroy())
          socket.once('close', () => {
            sockets.delete(id as number)
            void channel.send({ type: 'close', id }).catch(() => {})
          })
          void (async () => {
            try {
              for await (const data of socket)
                await channel.send({ type: 'data', id, data: Buffer.from(data).toString('base64') })
              await channel.send({ type: 'end', id })
            } catch {
              socket.destroy()
            }
          })()
        } else if (frame.type === 'data' || frame.type === 'end' || frame.type === 'close') {
          const socket = sockets.get(frame.id as number)
          if (!socket) continue
          if (frame.type === 'close') socket.destroy()
          else if (frame.type === 'end') socket.end()
          else {
            if (typeof frame.data !== 'string' || frame.data.length > 131072) throw new Error('Invalid VM bridge data')
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer)
                socket.off('close', done)
                resolve()
              }
              const timer = setTimeout(() => {
                socket.destroy()
                done()
              }, 5000)
              socket.once('close', done)
              socket.write(Buffer.from(frame.data as string, 'base64'), (error) => {
                if (error) socket.destroy()
                done()
              })
            })
          }
        } else if (['entry', 'chunk', 'file-end', 'delete', 'snapshot-end'].includes(frame.type as string)) {
          if (!imported || exported) throw new Error('Unexpected VM export')
          if (!exporting) {
            if (importing) throw new Error('VM exported during import')
            exporting = true
            transfer = spawn(options.fileBroker, ['apply', config], {
              stdio: ['pipe', 'ignore', 'pipe'],
              windowsHide: true
            })
            diagnostics(transfer.stderr!)
            transfer.stdin!.on('error', fail)
            transferExit = new Promise<void>((resolve, reject) => {
              transfer!.once('error', reject)
              transfer!.once('close', (code) =>
                code === 0 ? resolve() : reject(new Error('VM export failed; private disk retained for recovery'))
              )
            })
            void transferExit.catch(fail)
          }
          await new Promise<void>((resolve, reject) => {
            transfer!.stdin!.write(JSON.stringify(frame) + '\n', (error) => (error ? reject(error) : resolve()))
          })
          if (frame.type === 'snapshot-end') {
            transfer!.stdin!.end()
            await transferExit
            await rename(nextBaseline, baseline)
            exported = true
            await channel.send({ type: 'exported' })
          }
        } else if (frame.type === 'worker-exit') {
          if (!failing) exitCode = typeof frame.code === 'number' ? frame.code : 1
        } else if (frame.type === 'fatal') {
          throw new Error(typeof frame.message === 'string' ? frame.message.slice(0, 1024) : 'VM failed')
        } else throw new Error('Unexpected VM frame')
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'VM failed')
        fail()
      }
    }
    await closed
    if (!exported) throw new Error('VM stopped without exporting; private disk retained for recovery')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'VM failed')
    fail()
    await closed
  } finally {
    if (timer) clearTimeout(timer)
    for (const socket of sockets.values()) socket.destroy()
    transfer?.kill()
    await rm(operation, { recursive: true, force: true })
    process.exit(exitCode)
  }
}
