import { createServer } from 'node:http'

import { createAgentHost, type AgentHostProvider } from '@keundal/agent-host'

import { createAgentApp } from './app.js'

const configuredProvider = (process.env.KEUNDAL_PROVIDER ?? '').trim() as AgentHostProvider | ''
const resolvedProvider: AgentHostProvider =
  configuredProvider || (process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : 'anthropic')
if (!['openai', 'gemini', 'anthropic'].includes(resolvedProvider)) {
  console.error('KEUNDAL_PROVIDER는 openai, gemini, anthropic 중 하나여야 합니다.')
  process.exit(1)
}
const apiKey =
  resolvedProvider === 'openai'
    ? (process.env.OPENAI_API_KEY ?? '')
    : resolvedProvider === 'gemini'
      ? (process.env.GEMINI_API_KEY ?? '')
      : (process.env.ANTHROPIC_API_KEY ?? '')
const model = process.env.KEUNDAL_MODEL
const contextWindow = Number(process.env.KEUNDAL_CONTEXT_WINDOW ?? 128_000)
const maxOutputTokens = Number(process.env.KEUNDAL_MAX_OUTPUT_TOKENS ?? 4_096)
const sqlitePath = process.env.KEUNDAL_SQLITE_PATH ?? 'keundal-server.sqlite'
const maxRequestBodyBytes = process.env.KEUNDAL_MAX_REQUEST_BODY_BYTES
const sidecar = process.env.KEUNDAL_SIDECAR === '1'
const host = process.env.KEUNDAL_HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? (sidecar ? 0 : 8000))
if (!host.trim()) throw new Error('KEUNDAL_HOST는 비어 있을 수 없습니다.')
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('PORT가 올바르지 않습니다.')
if (!model?.trim()) {
  console.error('KEUNDAL_MODEL 환경 변수를 설정하세요. 예: gpt-4.1-mini, gemini-2.5-flash, claude-sonnet-4-5')
  process.exit(1)
}
if (!apiKey.trim()) {
  console.error('OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY 중 하나를 설정하세요.')
  process.exit(1)
}

const headers = process.env.KEUNDAL_HEADERS
  ? (JSON.parse(process.env.KEUNDAL_HEADERS) as Record<string, string>)
  : undefined
const agentHost = await createAgentHost({
  provider: resolvedProvider,
  apiKey,
  model,
  models: { [model]: { contextWindow, maxOutputTokens } },
  sqlitePath,
  maxOutputTokens,
  baseURL: process.env.KEUNDAL_BASE_URL || undefined,
  headers
})

const app = createAgentApp(agentHost.services, {
  token: process.env.KEUNDAL_API_TOKEN ?? '',
  maxRequestBodyBytes: maxRequestBodyBytes === undefined ? undefined : Number(maxRequestBodyBytes),
  allowedOrigins: (process.env.KEUNDAL_CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
})

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
