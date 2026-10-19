import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { TextDecoder } from 'node:util'

import { ShellService, type ExecutionOptions, type ShellRequest, type ShellResult } from '@keundal/core'
import type { Context } from 'cordis'

export interface LocalShellConfig {
  readonly cwd: string
  readonly shell?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly killGraceMs?: number
}

function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new TypeError(`${name} must be a positive integer no greater than 2147483647`)
  }
  return value
}

function pathString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

export class LocalShellService extends ShellService {
  private readonly root: string
  private readonly shell: string
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly killGraceMs: number
  private closed = false
  private readonly active = new Map<AbortController, Promise<ShellResult>>()

  constructor(ctx: Context, config: LocalShellConfig) {
    super(ctx)
    if (!config || !pathString(config.cwd)) throw new TypeError('cwd is required')
    this.root = realpathSync(config.cwd)
    if (!statSync(this.root).isDirectory()) throw new TypeError('cwd must be a directory')
    if (config.shell !== undefined && !pathString(config.shell)) throw new TypeError('invalid shell executable')
    this.shell = config.shell ?? (process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh')
    this.timeoutMs = positive(config.timeoutMs === undefined ? 120000 : config.timeoutMs, 'timeoutMs')
    this.maxOutputBytes = positive(
      config.maxOutputBytes === undefined ? 64000 : config.maxOutputBytes,
      'maxOutputBytes'
    )
    this.killGraceMs = positive(config.killGraceMs === undefined ? 100 : config.killGraceMs, 'killGraceMs')
    ctx.fiber.effect(() => async () => {
      this.closed = true
      for (const controller of this.active.keys()) controller.abort()
      await Promise.allSettled(this.active.values())
    })
  }

  async execute(request: ShellRequest, options: ExecutionOptions = {}): Promise<ShellResult> {
    if (this.closed) throw new Error('local shell disposed')
    options.signal?.throwIfAborted()
    if (!request || !pathString(request.command)) throw new TypeError('command is required')
    if (request.cwd !== undefined && !pathString(request.cwd)) throw new TypeError('invalid cwd')
    const timeout = positive(request.timeoutMs === undefined ? this.timeoutMs : request.timeoutMs, 'timeoutMs')
    if (timeout > this.timeoutMs) throw new RangeError('timeoutMs exceeds configured maximum')
    const cwd = realpathSync(resolve(this.root, request.cwd ?? '.'))
    const delta = relative(this.root, cwd)
    if (isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`))
      throw new Error('cwd is outside configured root')
    if (!statSync(cwd).isDirectory()) throw new TypeError('cwd must be a directory')
    options.signal?.throwIfAborted()
    const controller = new globalThis.AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    const pending = this.run(request.command, cwd, timeout, controller.signal)
    this.active.set(controller, pending)
    try {
      return await pending
    } finally {
      options.signal?.removeEventListener('abort', abort)
      this.active.delete(controller)
    }
  }

  private run(command: string, cwd: string, timeout: number, signal: AbortSignal): Promise<ShellResult> {
    return new Promise((resolveResult, reject) => {
      const windows = process.platform === 'win32'
      const child = spawn(this.shell, windows ? ['/d', '/s', '/c', command] : ['-c', command], {
        cwd,
        detached: !windows,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      const buffers: Buffer[][] = [[], []]
      const sizes = [0, 0]
      let truncated = false
      let timedOut = false
      let aborted = false
      let stopping = false
      let finished = false
      let exited = false
      let exitCode: number | null = null
      let exitSignal: string | null = null
      let escalation: ReturnType<typeof setTimeout> | undefined
      const decode = (chunks: Buffer[]) => {
        const decoder = () => new TextDecoder('utf-8', { ignoreBOM: true })
        const value = decoder().decode(Buffer.concat(chunks), { stream: true })
        const encoded = Buffer.from(value)
        if (encoded.length <= this.maxOutputBytes) return value
        truncated = true
        return decoder().decode(encoded.subarray(0, this.maxOutputBytes), { stream: true })
      }
      const kill = (force: boolean) => {
        if (!child.pid) return
        if (windows) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          })
          killer.on('error', () => {
            child.kill()
          })
          killer.unref()
        } else {
          try {
            process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(force ? 'SIGKILL' : 'SIGTERM')
          }
        }
      }
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        clearTimeout(escalation)
        signal.removeEventListener('abort', cancel)
        child.stdout.destroy()
        child.stderr.destroy()
        if (error) reject(error)
        else
          resolveResult({
            stdout: decode(buffers[0]!),
            stderr: decode(buffers[1]!),
            exitCode,
            signal: exitSignal,
            timedOut,
            aborted,
            truncated
          })
      }
      const stop = () => {
        if (stopping || finished) return
        stopping = true
        kill(false)
        escalation = setTimeout(() => {
          escalation = undefined
          kill(true)
          child.stdout.destroy()
          child.stderr.destroy()
          if (exited) finish()
        }, this.killGraceMs)
      }
      const cancel = () => {
        if (stopping || finished) return
        aborted = true
        stop()
      }
      const timer = setTimeout(() => {
        if (stopping || finished) return
        timedOut = true
        stop()
      }, timeout)
      signal.addEventListener('abort', cancel, { once: true })
      ;[child.stdout, child.stderr].forEach((stream, index) => {
        stream.on('data', (chunk: Buffer) => {
          const available = this.maxOutputBytes - sizes[index]!
          if (chunk.length > available) truncated = true
          const kept = chunk.subarray(0, Math.max(0, available))
          if (kept.length) buffers[index]!.push(Buffer.from(kept))
          sizes[index]! += kept.length
        })
      })
      child.on('error', (error) => finish(error))
      child.on('exit', (code, sig) => {
        clearTimeout(timer)
        exited = true
        exitCode = code
        exitSignal = sig
        if (stopping && !escalation) finish()
        else stop()
      })
      child.on('close', () => {
        if (!stopping) finish()
      })
    })
  }
}

export function localShellPlugin(ctx: Context, config: LocalShellConfig): void {
  new LocalShellService(ctx, config)
}

export default localShellPlugin
