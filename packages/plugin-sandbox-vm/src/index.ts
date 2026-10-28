import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'

import type { SandboxProcessRequest, SandboxProvider } from '@keundal/sandbox'

import { LineChannel } from './protocol.js'
import { supervise } from './supervisor.js'

/** Operator-installed, trusted Linux guest assets; never paths supplied by an agent or approval. */
export interface LinuxVmOptions {
  readonly qemu: string
  readonly qemuImg: string
  readonly kernel: string
  readonly initramfs: string
  readonly fileBroker: string
  readonly stateDirectory: string
}

/** A Linux VM on every host OS, with no NIC, host shares, or host service endpoints. */
export class LinuxVmSandboxProvider implements SandboxProvider {
  readonly startupTimeoutMs = 180_000
  private readonly options: LinuxVmOptions

  constructor(options: LinuxVmOptions) {
    for (const key of ['qemu', 'qemuImg', 'kernel', 'initramfs', 'fileBroker'] as const) {
      if (!isAbsolute(options[key]) || !statSync(realpathSync(options[key])).isFile()) {
        throw new Error(`VM ${key} must name an installed absolute file`)
      }
    }
    if (!isAbsolute(options.stateDirectory)) throw new Error('VM stateDirectory must be absolute')
    this.options = options
  }

  start(request: SandboxProcessRequest): ChildProcessWithoutNullStreams {
    // Deliver only this trusted, self-contained supervisor over stdin. This also works
    // when the provider is bundled into Nitro/desktop, without loading adjacent JS files.
    // Plugin source and credentials travel as IPC data, never as generated JavaScript.
    const child = spawn(process.execPath, ['--input-type=module'], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      shell: false,
      windowsHide: true
    })
    child.stdin!.end(
      `(${supervise.toString()})(${LineChannel.toString()}).catch(error => { console.error(error.message); process.exit(1) })`
    )
    child.send!({ options: this.options, request })
    return child as ChildProcessWithoutNullStreams
  }

  async stop(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (child.exitCode === 0) return
      throw new Error('VM export failed; private disk retained for recovery')
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('VM shutdown timed out; private disk retained for recovery'))
      }, 125_000)
      // Completion is the supervisor's exit result, not the lifetime of parent
      // diagnostic streams (which may already have been destroyed).
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error('VM export failed; private disk retained for recovery'))
      })
      child.send!({ type: 'shutdown' }, (error) => {
        if (error) child.kill()
      })
    })
  }
}
