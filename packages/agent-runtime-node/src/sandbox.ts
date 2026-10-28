import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Agent, request, type RequestListener } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'

import { LinuxSandboxProvider } from '@keundal/plugin-sandbox-linux'
import type { SandboxPolicy, SandboxProvider } from '@keundal/sandbox'

import { createSandboxNetwork } from './sandbox-network.js'

export type { SandboxPolicy, SandboxProvider } from '@keundal/sandbox'

export interface SandboxedAgentRuntime {
  readonly app: RequestListener
  dispose(): Promise<void>
}

export async function readSandboxPolicy(env: Readonly<Record<string, string | undefined>>): Promise<SandboxPolicy> {
  if (!env.KEUNDAL_SANDBOX_CONFIG) throw new Error('KEUNDAL_SANDBOX_CONFIG is required for the execution host')
  const policy: unknown = JSON.parse(await readFile(env.KEUNDAL_SANDBOX_CONFIG, 'utf8'))
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('Invalid sandbox policy')
  const value = policy as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) => !['workspace', 'readOnlyPaths', 'writablePaths', 'allowedHosts', 'environment'].includes(key)
    ) ||
    typeof value.workspace !== 'string' ||
    !value.workspace ||
    ['readOnlyPaths', 'writablePaths', 'allowedHosts'].some(
      (key) =>
        value[key] !== undefined &&
        (!Array.isArray(value[key]) ||
          !(value[key] as unknown[]).every((item) => typeof item === 'string' && item.length > 0))
    ) ||
    (value.environment !== undefined &&
      (!value.environment ||
        typeof value.environment !== 'object' ||
        Array.isArray(value.environment) ||
        !Object.values(value.environment).every((item) => typeof item === 'string')))
  )
    throw new TypeError('Invalid sandbox policy')
  return value as unknown as SandboxPolicy
}

/** Starts the entire execution host, never importing operator-selected code in this process. */
export async function createSandboxedAgentRuntime(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly policy?: SandboxPolicy
    readonly provider?: SandboxProvider
    readonly workerSource?: string
  } = {}
): Promise<SandboxedAgentRuntime> {
  const env = options.env ?? process.env
  const policy = options.policy ?? (await readSandboxPolicy(env))
  // An unsupported platform or unavailable isolation facility must never fall back to spawn(node).
  const provider = options.provider ?? new LinuxSandboxProvider()
  const workerSource =
    options.workerSource ?? (await readFile(new URL('./worker/sandbox-worker.txt', import.meta.url), 'utf8'))
  const network = createSandboxNetwork(policy.allowedHosts)
  const bridge = await mkdtemp(join(tmpdir(), 'keundal-sandbox-'))
  const sockets = new Set<Socket>()
  const idle: Socket[] = []
  type ConnectionCallback = (error: Error | null, socket?: Socket) => void
  const waiting = new Set<ConnectionCallback>()
  let disposed = false
  const api = createServer((socket) => {
    if (disposed || idle.length >= 8) return socket.destroy()
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      sockets.delete(socket)
      const index = idle.indexOf(socket)
      if (index !== -1) idle.splice(index, 1)
    })
    const callback = waiting.values().next().value
    if (callback) {
      waiting.delete(callback)
      callback(null, socket)
    } else idle.push(socket)
  })
  const agent = new Agent({ keepAlive: false, maxSockets: 64 })
  agent.createConnection = (_options, onCreate) => {
    if (!onCreate) throw new Error('Connection callback is required')
    // Node's error-first callback accepts an absent stream on connection failure.
    const callback = onCreate as ConnectionCallback
    if (disposed) {
      callback(new Error('Sandbox host is closed'))
      return undefined
    }
    const socket = idle.shift()
    if (socket) {
      callback(null, socket)
      return undefined
    }
    const done: ConnectionCallback = (error, connected) => {
      clearTimeout(timer)
      waiting.delete(done)
      callback(error, connected)
    }
    const timer = setTimeout(() => done(new Error('Sandbox host connection timed out')), 20_000)
    waiting.add(done)
    return undefined
  }
  let child: ReturnType<SandboxProvider['start']> | undefined
  let exited: Promise<unknown> | undefined
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true
    disposal = (async () => {
      agent.destroy()
      for (const callback of waiting) callback(new Error('Sandbox host is closed'))
      for (const socket of sockets) socket.destroy()
      network.close()
      api.close()
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child?.kill('SIGKILL'), 1000)
        await exited
        clearTimeout(timer)
      }
      await rm(bridge, { recursive: true, force: true })
    })()
    return disposal
  }
  try {
    await writeFile(join(bridge, 'worker.mjs'), workerSource, { mode: 0o600 })
    api.listen(join(bridge, 'api.sock'))
    await once(api, 'listening')
    network.server.listen(join(bridge, 'network.sock'))
    await once(network.server, 'listening')
    const environment: Record<string, string> = {}
    for (const key of [
      'KEUNDAL_PROVIDER',
      'KEUNDAL_MODEL',
      'KEUNDAL_CONTEXT_WINDOW',
      'KEUNDAL_MAX_OUTPUT_TOKENS',
      'KEUNDAL_API_TOKEN',
      'KEUNDAL_MAX_REQUEST_BODY_BYTES',
      'KEUNDAL_CORS_ORIGINS',
      'KEUNDAL_SQLITE_PATH',
      'KEUNDAL_BASE_URL',
      'KEUNDAL_HEADERS',
      'KEUNDAL_MCP_SERVERS',
      'KEUNDAL_TOOL_APPROVAL',
      'KEUNDAL_PLUGIN_CONFIG',
      'KEUNDAL_MANAGED_PLUGINS',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'ANTHROPIC_API_KEY'
    ])
      if (env[key] !== undefined) environment[key] = env[key]!
    child = provider.start({
      executable: process.execPath,
      args: ['/run/keundal/worker.mjs'],
      policy,
      environment: { ...environment, ...policy.environment },
      protectedPaths: [
        dirname(fileURLToPath(import.meta.url)),
        ...(process.argv[1] ? [dirname(resolve(process.argv[1]))] : []),
        ...(env.KEUNDAL_SANDBOX_CONFIG ? [resolve(env.KEUNDAL_SANDBOX_CONFIG)] : [])
      ],
      // All bridge endpoints are created by the parent and mounted read-only. The child cannot
      // substitute a host socket path and trick the parent into connecting to another service.
      mounts: ['worker.mjs', 'api.sock', 'network.sock'].map((name) => ({
        source: join(bridge, name),
        target: `/run/keundal/${name}`,
        writable: false
      }))
    })
    const started = child
    exited = new Promise<void>((resolve) => started.once('close', () => resolve()))
    started.stderr.pipe(process.stderr, { end: false })
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Sandbox host startup timed out'))
      }, 20_000)
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-65536)
        if (output.split('\n').includes('keundal-sandbox-ready')) {
          cleanup()
          resolve()
        }
      }
      const onExit = () => {
        cleanup()
        reject(new Error('Sandbox host exited before becoming ready'))
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        clearTimeout(timer)
        started.stdout.off('data', onData)
        started.off('exit', onExit)
        started.off('error', onError)
      }
      started.stdout.on('data', onData)
      started.once('exit', onExit)
      started.once('error', onError)
    })
    started.stdout.resume()
    started.once('exit', () => {
      void dispose()
    })
    return {
      dispose,
      app(incoming, outgoing) {
        if (disposed) {
          outgoing.writeHead(503).end()
          return
        }
        const upstream = request(
          { agent, host: 'sandbox', path: incoming.url, method: incoming.method, headers: incoming.headers },
          (response) => {
            response.on('error', () => outgoing.destroy())
            try {
              outgoing.writeHead(response.statusCode ?? 502, response.headers)
            } catch {
              // Child-controlled headers can parse successfully but fail Node's serializer.
              // Terminate only this exchange, never the trusted parent process.
              response.destroy()
              outgoing.destroy()
              return
            }
            response.pipe(outgoing)
          }
        )
        upstream.on('error', () => {
          if (outgoing.destroyed) return
          if (!outgoing.headersSent) outgoing.writeHead(503).end()
          else outgoing.destroy()
        })
        incoming.once('aborted', () => upstream.destroy())
        outgoing.once('close', () => upstream.destroy())
        incoming.pipe(upstream)
      }
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
