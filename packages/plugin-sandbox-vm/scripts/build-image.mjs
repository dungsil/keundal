#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

// Operator tool, deliberately never invoked on host startup or from agent input.
// Usage: node scripts/build-image.mjs --output /operator/assets --guest /built/guest.mjs [--kernel /boot/vmlinuz-VERSION]
const options = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!['--output', '--guest', '--kernel'].includes(key) || !process.argv[i + 1] || options.has(key))
    throw new Error('Expected --output DIR --guest BUNDLE [--kernel FILE]')
  options.set(key, process.argv[i + 1])
}
if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node !== '24.22.1')
  throw new Error('Build requires Linux x64 and pinned Node 24.22.1')
if (!options.has('--output') || !options.has('--guest')) throw new Error('--output and --guest are required')
const output = resolve(options.get('--output'))
const guest = resolve(options.get('--guest'))
const image = fileURLToPath(new URL('../image/', import.meta.url))
function run(program, args, extra = {}) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
    ...extra
  })
  if (result.status !== 0) throw new Error(`Image tool failed: ${program}`)
  return result.stdout
}
const kernels = (await fs.readdir('/boot'))
  .filter((name) => /^vmlinuz-.*amd64$/.test(name))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
const kernel = resolve(options.get('--kernel') ?? join('/boot', kernels.at(-1) ?? 'missing'))
const version = kernel
  .split('/')
  .at(-1)
  .replace(/^vmlinuz-/, '')
const moduleDirectory = `/lib/modules/${version}`
const root = await fs.mkdtemp(join(tmpdir(), 'keundal-image-'))
await fs.chmod(root, 0o700)
const copied = new Set()
async function copy(source, destination = source, executable = false) {
  if (!isAbsolute(destination) || destination.includes('/../')) throw new Error('Invalid image destination')
  const path = join(root, destination)
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.copyFile(await fs.realpath(source), path)
  await fs.chmod(path, executable ? 0o755 : 0o644) // Strip all setuid/setgid and extended metadata.
}
async function binary(source, destination) {
  await copy(source, destination, true)
  const dependencies = run('/usr/bin/ldd', [source])
  if (/not found/.test(dependencies)) throw new Error('Missing binary dependency')
  for (const line of dependencies.split('\n')) {
    const dependency = line.match(/(?:=>\s*)?(\/[^\s]+)\s+\(/)?.[1]
    if (dependency && !copied.has(dependency)) {
      copied.add(dependency)
      await copy(dependency, dependency, true)
    }
  }
}
try {
  await fs.mkdir(output, { recursive: true, mode: 0o700 })
  // Refuse clobbering installed assets; an interrupted build is never an installed image.
  for (const name of ['kernel', 'initramfs.cpio.gz', 'manifest.json']) {
    try {
      await fs.access(join(output, name))
      throw new Error(`Output already exists: ${name}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  for (const directory of ['proc', 'sys', 'dev', 'run', 'state', 'tmp', 'bin', 'sbin', 'usr/bin', 'etc', 'home'])
    await fs.mkdir(join(root, directory), { recursive: true, mode: directory === 'tmp' ? 0o1777 : 0o755 })
  await copy('/usr/bin/busybox', '/bin/busybox', true) // Debian busybox-static, no host configuration.
  const busybox = run('/usr/bin/file', ['/usr/bin/busybox'])
  if (!busybox.includes('statically linked')) throw new Error('busybox-static is required')
  for (const applet of run('/usr/bin/busybox', ['--list'])
    .trim()
    .split('\n')
    .filter((name) => name !== 'busybox'))
    await fs.symlink('busybox', join(root, 'bin', applet))
  await binary(process.execPath, '/usr/bin/node')
  await binary('/usr/bin/git', '/usr/bin/git')
  await binary('/sbin/mke2fs', '/sbin/mke2fs')
  await binary('/sbin/e2fsck', '/sbin/e2fsck')
  // Supply only fixed, non-host-specific filesystem defaults.
  await fs.writeFile(
    join(root, 'etc/mke2fs.conf'),
    '[defaults]\nbase_features = sparse_super,large_file,filetype,resize_inode,dir_index,ext_attr\nblocksize = 4096\ninode_size = 256\ninode_ratio = 16384\n[fs_types]\next4 = {\nfeatures = has_journal,extent,huge_file,flex_bg,metadata_csum,64bit,dir_nlink,extra_isize\n}\n'
  )
  const deps = new Map(
    (await fs.readFile(join(moduleDirectory, 'modules.dep'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const [name, rest] = line.split(':')
        return [name, rest.trim().split(/\s+/).filter(Boolean)]
      })
  )
  const builtins = await fs.readFile(join(moduleDirectory, 'modules.builtin'), 'utf8')
  const loaded = new Set()
  const ordered = []
  async function module(name) {
    if (loaded.has(name)) return
    loaded.add(name)
    if (!deps.has(name)) throw new Error('Missing kernel module dependency')
    for (const dependency of deps.get(name)) await module(dependency)
    await copy(join(moduleDirectory, name), `/modules/${name}`)
    ordered.push(`/modules/${name}`)
  }
  for (const name of ['virtio_pci', 'virtio_blk', 'virtio_console', 'ext4']) {
    const pattern = new RegExp(`/${name}\\.ko(?:\\.(?:xz|zst|gz))?$`)
    const found = [...deps.keys()].find((path) => pattern.test(path))
    if (found) {
      if (!found.endsWith('.ko')) throw new Error('Uncompressed kernel modules are required')
      await module(found)
    } else if (!builtins.split('\n').some((path) => pattern.test(path))) throw new Error(`Kernel lacks ${name}`)
  }
  await fs.writeFile(join(root, 'modules.load'), ordered.join('\n') + '\n')
  await copy(join(image, 'init'), '/init', true)
  await copy(join(image, 'prepare-state.mjs'), '/prepare-state.mjs')
  await copy(guest, '/guest.mjs')
  const archive = join(root, '..', `${root.split('/').at(-1)}.cpio.gz`)
  try {
    await fs.chmod(root, 0o755) // The archived / must be traversable by uid 1000.
    // Fixed cwd and no caller strings in shell source. cpio forces root ownership.
    run(
      '/bin/bash',
      [
        '-o',
        'pipefail',
        '-c',
        'find . -print0 | sort -z | cpio --null -o --format=newc --owner=0:0 --quiet | gzip -n -9 > "$1"',
        'build-image',
        archive
      ],
      { cwd: root }
    )
    await fs.copyFile(kernel, join(output, 'kernel'), 1)
    await fs.copyFile(archive, join(output, 'initramfs.cpio.gz'), 1)
  } finally {
    await fs.rm(archive, { force: true })
  }
  const sha256 = async (path) =>
    createHash('sha256')
      .update(await fs.readFile(path))
      .digest('hex')
  await fs.writeFile(
    join(output, 'manifest.json'),
    JSON.stringify(
      {
        architecture: 'x86_64',
        node: process.versions.node,
        kernel: version,
        modules: ordered,
        sha256: {
          kernel: await sha256(join(output, 'kernel')),
          initramfs: await sha256(join(output, 'initramfs.cpio.gz')),
          guest: await sha256(guest),
          node: await sha256(process.execPath)
        }
      },
      null,
      2
    ) + '\n',
    { mode: 0o600, flag: 'wx' }
  )
  process.stdout.write(`Kernel: ${join(output, 'kernel')}\nInitramfs: ${join(output, 'initramfs.cpio.gz')}\n`)
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
