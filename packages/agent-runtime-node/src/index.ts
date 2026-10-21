import process from 'node:process'

import { createAgentHost, type AgentHostOptions, type AgentHost } from '@keundal/agent-host'
import { createAgentApp, type AgentAppOptions } from '@keundal/agent-host/http'
import type { AgentPluginOptions, LoadedAgentPlugin } from '@keundal/agent-plugins'
import type { McpClientConfig } from '@keundal/mcp'
import type { ExecutableTool, ToolProvider } from '@keundal/tools'

export { createNodeComposition } from './default-composition.js'

export type AgentHostProvider = 'openai' | 'gemini' | 'anthropic'
export interface NodeHostOptions {
  readonly plugins?: readonly AgentPluginOptions[]
  readonly mcpServers?: readonly McpClientConfig[]
  readonly provider: AgentHostProvider
  readonly apiKey: string
  /** 기본 모델 ID입니다. `models`에 포함되어야 합니다. */
  readonly model: string
  /** 사용할 수 있는 모델과 한도입니다. */
  readonly models?: Readonly<Record<string, Omit<import('@keundal/agent-host').AgentHostModel, 'id' | 'provider'>>>
  readonly sqlitePath: string
  readonly maxOutputTokens?: number
  readonly tools?: readonly ExecutableTool[] | ToolProvider
  readonly subagents?: boolean
  readonly maxActiveSubagents?: number
  readonly maxToolRounds?: number
  readonly baseURL?: string
  readonly headers?: Readonly<Record<string, string>>
}

export type HostComposition = Pick<AgentHostOptions, 'setup' | 'mountAgent'> & {
  plugins?: readonly LoadedAgentPlugin[]
}
export type HostCompositionFactory = (options: NodeHostOptions) => HostComposition

export async function createNodeAgentHost(options: NodeHostOptions, compose: HostCompositionFactory) {
  const models = options.models ?? { [options.model]: { contextWindow: 128000, maxOutputTokens: 4096 } }
  const composition = compose(options)
  const host = await createAgentHost({
    model: options.model,
    models: Object.entries(models).map(([id, limits]) => ({ id, provider: options.provider, ...limits })),
    maxOutputTokens: options.maxOutputTokens,
    ...composition
  })
  return { ...host, plugins: composition.plugins ?? [] }
}

export interface AgentRuntime extends AgentHost {
  readonly plugins: readonly LoadedAgentPlugin[]
  readonly app: ReturnType<typeof createAgentApp>
}

/** 웹 서버와 데스크톱이 같은 환경 설정으로 호스트를 조립합니다. */
export async function createAgentRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Pick<NodeHostOptions, 'tools' | 'plugins' | 'subagents' | 'maxActiveSubagents'> & {
    compose: HostCompositionFactory
  }
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
  const host = await createNodeAgentHost(
    {
      tools: options.tools,
      subagents: options.subagents,
      maxActiveSubagents: options.maxActiveSubagents,
      plugins: options.plugins,
      mcpServers: env.KEUNDAL_MCP_SERVERS ? JSON.parse(env.KEUNDAL_MCP_SERVERS) : [],
      provider,
      apiKey: apiKey ?? '',
      model,
      models: { [model]: { contextWindow, maxOutputTokens } },
      sqlitePath,
      maxOutputTokens,
      baseURL: env.KEUNDAL_BASE_URL || undefined,
      headers: env.KEUNDAL_HEADERS ? (JSON.parse(env.KEUNDAL_HEADERS) as Record<string, string>) : undefined
    },
    options.compose
  )
  try {
    return { ...host, app: createAgentApp(host.services, appOptions) }
  } catch (error) {
    await host.dispose()
    throw error
  }
}
