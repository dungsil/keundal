import { createServer } from 'node:http'

import { createAgentRuntime } from '@keundal/agent-host/runtime'

const sidecar = process.env.KEUNDAL_SIDECAR === '1'
const host = process.env.KEUNDAL_HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? (sidecar ? 0 : 8000))
if (!host.trim()) throw new Error('KEUNDAL_HOST는 비어 있을 수 없습니다.')
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('PORT가 올바르지 않습니다.')
const agentHost = await createAgentRuntime()
const app = agentHost.app

const server = createServer(app).listen(port, host, () => {
  const address = server.address()
  const boundPort = address && typeof address !== 'string' ? address.port : port
  const displayHost = host.includes(':') ? `[${host}]` : host
  const url = `http://${displayHost}:${boundPort}`
  console.log(`keundal server listening on ${url}`)
  console.log(
    `POST /runs · GET /threads · GET /threads/:id · PUT /threads/:id · DELETE /threads/:id · GET /runs · GET /runs/:id · POST /recover · GET /models · POST /title`
  )
  if (sidecar) console.log(JSON.stringify({ kind: 'keundal-sidecar', port: boundPort, url }))
})

const parentPid = Number(process.env.KEUNDAL_PARENT_PID ?? 0)
if (Number.isSafeInteger(parentPid) && parentPid > 0) {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch {
      server.close()
      void agentHost.dispose().finally(() => process.exit(0))
    }
  }, 1_000)
  timer.unref()
}

const shutdown = async () => {
  server.close()
  await agentHost.dispose()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

if (sidecar && process.env.KEUNDAL_SHUTDOWN_ON_STDIN === '1') {
  process.stdin.once('end', () => { void shutdown() })
  process.stdin.resume()
}
