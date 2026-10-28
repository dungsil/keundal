import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect, createServer as createNetServer } from 'node:net'
import process from 'node:process'

import { ProxyAgent, setGlobalDispatcher } from 'undici'

import type { SandboxedAgentRuntime } from './sandbox.js'

/** Bootstrap called only by the dedicated worker, after OS isolation is established. */
export async function serveSandboxedAgentRuntime(create: () => Promise<SandboxedAgentRuntime>): Promise<void> {
  // A loopback proxy is private to this network namespace. Non-proxy network calls cannot leave it.
  const proxy = createNetServer((client) => {
    const upstream = connect('/run/keundal/network.sock')
    const close = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', close)
    upstream.on('error', close)
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
    client.pipe(upstream).pipe(client)
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('Sandbox proxy did not start')
  const proxyURL = `http://127.0.0.1:${address.port}`
  const dispatcher = new ProxyAgent(proxyURL)
  setGlobalDispatcher(dispatcher)
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) process.env[name] = proxyURL
  process.env.NO_PROXY = ''
  process.env.no_proxy = ''
  const runtime = await create()
  const server = createServer((request, response) => {
    // Replenish the reverse connection pool before running the request, including long-lived SSE.
    const socket = request.socket
    if (!used.has(socket)) {
      used.add(socket)
      open()
    }
    runtime.app(request, response)
  })
  const used = new WeakSet<object>()
  let closing = false
  function open() {
    if (closing) return
    const socket = connect('/run/keundal/api.sock')
    socket.once('connect', () => server.emit('connection', socket))
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      if (!used.has(socket)) open()
    })
  }
  const shutdown = async () => {
    if (closing) return
    closing = true
    proxy.close()
    server.closeAllConnections()
    await runtime.dispose()
    await dispatcher.destroy()
    process.exit(0)
  }
  process.once('SIGTERM', () => {
    void shutdown()
  })
  process.once('SIGINT', () => {
    void shutdown()
  })
  process.stdin.once('end', () => {
    void shutdown()
  })
  process.stdin.resume()
  open()
  open()
  process.stdout.write('keundal-sandbox-ready\n')
}
