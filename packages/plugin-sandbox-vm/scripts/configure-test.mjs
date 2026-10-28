import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const [assets, destination] = process.argv.slice(2)
if (!assets || !destination) throw new Error('Expected GUEST_ASSETS_DIRECTORY CONFIG_FILE')
const windows = process.platform === 'win32'
const directories = (process.env.PATH ?? '').split(delimiter)
if (windows) directories.push(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qemu'))
function executable(name) {
  for (const directory of directories) {
    const candidate = resolve(directory, name + (windows ? '.exe' : ''))
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`Install ${name} before configuring VM tests`)
}
const config = resolve(destination)
await writeFile(
  config,
  JSON.stringify({
    qemu: executable('qemu-system-x86_64'),
    qemuImg: executable('qemu-img'),
    kernel: resolve(assets, 'kernel'),
    initramfs: resolve(assets, 'initramfs.cpio.gz'),
    fileBroker: fileURLToPath(
      new URL(`../file-broker/target/release/keundal-file-broker${windows ? '.exe' : ''}`, import.meta.url)
    ),
    stateDirectory: join(dirname(config), 'keundal-vm-state')
  }) + '\n',
  { mode: 0o600, flag: 'wx' }
)
process.stdout.write(`KEUNDAL_TEST_VM_CONFIG=${config}\n`)
