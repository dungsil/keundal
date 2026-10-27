import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'

import { createAgentRuntime } from '@keundal/agent-runtime-node'
import { createChartTools } from '@keundal/plugin-tool-chart'
import { createWeatherTools } from '@keundal/plugin-tool-weather'
import { manageRuntimePlugins, createDesktopComposition } from './runtime-plugins.js'

if (process.argv[2] === '--manage-runtime-plugins') {
  try {
    let input = ''
    for await (const chunk of process.stdin) input += String(chunk)
    const directory = process.env.KEUNDAL_MANAGED_PLUGINS
    if (!directory) throw new Error('Managed plugin directory is missing')
    console.log(JSON.stringify(await manageRuntimePlugins(directory, JSON.parse(input))))
    process.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

const sidecar = process.env.KEUNDAL_SIDECAR === '1'
const host = process.env.KEUNDAL_HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? (sidecar ? 0 : 8000))
if (!host.trim()) throw new Error('KEUNDAL_HOST는 비어 있을 수 없습니다.')
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('PORT가 올바르지 않습니다.')
// 미디어 자료库와 도구는 데스크톱 프로세스만 로컬 실행 파일을 가지므로 여기서 기본 경로를 정합니다.
const env = {
  ...process.env,
  KEUNDAL_MEDIA_DIR:
    process.env.KEUNDAL_MEDIA_DIR ?? join(dirname(resolve(process.env.KEUNDAL_SQLITE_PATH ?? '.data/keundal.sqlite')), 'media')
}
const agentHost = await createAgentRuntime(env, {
  defaultTools: [...createChartTools(), ...createWeatherTools()],
  compose: createDesktopComposition(process.env.KEUNDAL_MANAGED_PLUGINS)
})
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
  console.log(
    `GET /media/tools · POST /media/tools/:name/install · PUT /media/tools/:name · POST /media/libraries · POST /media/libraries/open · POST /media/downloads`
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
  process.stdin.once('end', () => {
    void shutdown()
  })
  process.stdin.resume()
}
