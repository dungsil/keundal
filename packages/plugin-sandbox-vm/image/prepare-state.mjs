import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { open, writeFile } from 'node:fs/promises'

// Only an entirely zero-filled raw disk may be initialized. Unknown signatures,
// corrupted superblocks, partitioned disks and nonzero "empty" disks fail closed.
const disk = await open('/dev/vda', 'r')
const superblock = Buffer.alloc(1024)
await disk.read(superblock, 0, superblock.length, 1024)
// ext2/ext3 share the magic; require the journal and extents used by our ext4 fs.
const ext4 =
  superblock.readUInt16LE(56) === 0xef53 &&
  (superblock.readUInt32LE(92) & 4) !== 0 &&
  (superblock.readUInt32LE(96) & 0x40) !== 0
async function diagnostic(message) {
  await writeFile(
    '/dev/virtio-ports/keundal.control',
    JSON.stringify({ type: 'stderr', data: Buffer.from(message + '\n').toString('base64') }) + '\n'
  )
}
if (!ext4) {
  await diagnostic('Initializing private VM disk: verifying blank media')
  const bytes = Buffer.alloc(8 * 1024 * 1024)
  const zeros = Buffer.alloc(bytes.length)
  let position = 0
  for (;;) {
    const { bytesRead } = await disk.read(bytes, 0, bytes.length, position)
    if (!bytesRead) break
    if (!bytes.subarray(0, bytesRead).equals(zeros.subarray(0, bytesRead)))
      throw new Error('Nonempty state disk has no ext4 superblock')
    position += bytesRead
  }
  if (position < 32 * 1024 * 1024) throw new Error('State disk is too small')
  await diagnostic('Initializing private VM disk: creating ext4 filesystem')
}
await disk.close()
const command = ext4 ? '/sbin/e2fsck' : '/sbin/mke2fs'
const args = ext4
  ? ['-p', '/dev/vda']
  : [
      '-q',
      '-F',
      '-t',
      'ext4',
      '-m',
      '0',
      '-E',
      'lazy_itable_init=1,lazy_journal_init=1,nodiscard',
      '-L',
      'keundal-state',
      '/dev/vda'
    ]
const result = spawnSync(command, args, { stdio: 'ignore', env: { PATH: '/bin:/sbin' } })
if (result.status !== 0 && !(ext4 && result.status === 1)) throw new Error('State filesystem check failed')
