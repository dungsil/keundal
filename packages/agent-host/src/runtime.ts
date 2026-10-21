import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

import { createAgentApp, type AgentAppOptions } from './http.js'
import { createAgentHost, type AgentHost, type AgentHostProvider, type AgentHostOptions } from './index.js'

export interface AgentRuntime extends AgentHost {
  readonly app: ReturnType<typeof createAgentApp>
}

/** 웹 서버와 데스크톱이 같은 환경 설정으로 호스트를 조립합니다. */
export async function createAgentRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Pick<AgentHostOptions, 'tools' | 'plugins'> = {}
): Promise<AgentRuntime> {
  const provider = (env.KEUNDAL_PROVIDER ||
    (env.OPENAI_API_KEY ? 'openai' : env.GEMINI_API_KEY ? 'gemini' : 'anthropic')) as AgentHostProvider
  if (!['openai', 'gemini', 'anthropic'].includes(provider)) {
    throw new Error('KEUNDAL_PROVIDER는 openai, gemini, anthropic 중 하나여야 합니다.')
  }
  const apiKey =
    provider === 'openai' ? env.OPENAI_API_KEY : provider === 'gemini' ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY
  const model = env.KEUNDAL_MODEL
  if (!model?.trim()) throw new Error('KEUNDAL_MODEL 환경 변수를 설정하세요.')
  if (!env.KEUNDAL_PROVIDER && !apiKey?.trim())
    throw new Error('OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY 중 하나를 설정하세요.')
  const contextWindow = Number(env.KEUNDAL_CONTEXT_WINDOW ?? 128_000)
  const maxOutputTokens = Number(env.KEUNDAL_MAX_OUTPUT_TOKENS ?? 4_096)
  const appOptions: AgentAppOptions = {
    token: env.KEUNDAL_API_TOKEN ?? '',
    maxRequestBodyBytes:
      env.KEUNDAL_MAX_REQUEST_BODY_BYTES === undefined ? undefined : Number(env.KEUNDAL_MAX_REQUEST_BODY_BYTES),
    allowedOrigins: (env.KEUNDAL_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  }
  const sqlitePath = env.KEUNDAL_SQLITE_PATH ?? '.data/keundal.sqlite'
  if (sqlitePath !== ':memory:') mkdirSync(dirname(sqlitePath), { recursive: true })
  const host = await createAgentHost({
    tools: options.tools,
    workspace: env.KEUNDAL_WORKSPACE || undefined,
    plugins: options.plugins,
    provider,
    mcpServers: env.KEUNDAL_MCP_SERVERS ? JSON.parse(env.KEUNDAL_MCP_SERVERS) : [],
    apiKey: apiKey ?? '',
    model,
    models: { [model]: { contextWindow, maxOutputTokens } },
    sqlitePath,
    maxOutputTokens,
    baseURL: env.KEUNDAL_BASE_URL || undefined,
    headers: env.KEUNDAL_HEADERS ? (JSON.parse(env.KEUNDAL_HEADERS) as Record<string, string>) : undefined
  })
  try {
    return { ...host, app: createAgentApp(host.services, appOptions) }
  } catch (error) {
    await host.dispose()
    throw error
  }
}
