import { createServer, request as httpRequest, type OutgoingHttpHeaders, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { URL } from 'node:url'

function destination(authority: string): { host: string; port: number; key: string } {
  const match = /^(\[[\da-f:.]+\]|[a-z\d.-]+):([1-9]\d{0,4})$/i.exec(authority)
  if (!match || Number(match[2]) > 65535) throw new TypeError('Expected an exact host:port destination')
  const host = match[1]!.toLowerCase()
  return { host: host.replace(/^\[|\]$/g, ''), port: Number(match[2]), key: `${host}:${Number(match[2])}` }
}

/** The only network escape from the child's private network namespace. */
export function createSandboxNetwork(allowedHosts: readonly string[] = []): {
  server: Server
  close(): void
} {
  const allowed = new Set(allowedHosts.map((host) => destination(host).key))
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    let url: URL
    try {
      url = new URL(request.url ?? '')
      if (
        url.protocol !== 'http:' ||
        url.username ||
        url.password ||
        !allowed.has(destination(`${url.hostname}:${url.port || 80}`).key)
      )
        throw new Error('Denied')
    } catch {
      response.writeHead(403).end()
      return
    }
    const headers: OutgoingHttpHeaders = { ...request.headers, host: url.host }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const upstream = httpRequest(url, { method: request.method, headers }, (result) => {
      result.on('error', () => response.destroy())
      try {
        response.writeHead(result.statusCode ?? 502, result.headers)
      } catch {
        result.destroy()
        response.destroy()
        return
      }
      result.pipe(response)
    })
    upstream.on('socket', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    upstream.on('error', () => {
      if (response.destroyed) return
      if (!response.headersSent) response.writeHead(502).end()
      else response.destroy()
    })
    upstream.setTimeout(30_000, () => upstream.destroy())
    request.once('aborted', () => upstream.destroy())
    response.once('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', (request, client, head) => {
    let target: ReturnType<typeof destination>
    try {
      target = destination(request.url ?? '')
      if (!allowed.has(target.key)) throw new Error('Network destination is not allowed')
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = connect({ host: target.host, port: target.port })
    sockets.add(upstream)
    const close = () => {
      upstream.destroy()
      client.destroy()
    }
    upstream.once('close', () => {
      sockets.delete(upstream)
      client.destroy()
    })
    upstream.once('error', close)
    client.once('error', close)
    client.once('close', () => upstream.destroy())
    upstream.setTimeout(30_000, close)
    upstream.once('connect', () => {
      // Once connected, long-lived streams have the same lifetime as their callers.
      upstream.setTimeout(0)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
  })
  return {
    server,
    close() {
      server.close()
      for (const socket of sockets) socket.destroy()
    }
  }
}
