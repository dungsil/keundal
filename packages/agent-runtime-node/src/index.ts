import process from 'node:process'

import { createAgentHost, type AgentHostModel, type AgentHostOptions, type AgentHost } from '@keundal/agent-host'
import { createAgentApp, type AgentAppOptions } from '@keundal/agent-host/http'
import type { AgentPluginOptions, LoadedAgentPlugin } from '@keundal/agent-plugins'
import type { McpClientConfig } from '@keundal/mcp'
import type { RuntimePluginManifest } from '@keundal/plugin-runtime'
import type { ExecutableTool, ToolProvider } from '@keundal/tools'

export { createNodeComposition, getRequiredNodePluginModules, nodePluginMetadata } from './default-composition.js'

export type AgentHostProvider = 'openai' | 'gemini' | 'anthropic' | (string & {})
export type BundledPluginModule =
  | '@keundal/plugin-skill'
  | '@keundal/plugin-mcp-client'
  | '@keundal/plugin-tool-chart'
  | '@keundal/plugin-tool-weather'
  /** Legacy preference used only as a fallback for the split tool selections. */
  | '@keundal/plugin-tool-chat'
export type BundledPluginSelection = Readonly<Partial<Record<BundledPluginModule, boolean>>>

/** 미디어 자료库와 로컬 도구를 데스크톱 호스트에 조립하는 설정입니다. */
export interface NodeMediaOptions {
  /** 도구 실행 파일과 작업 로그를 저장하는 디렉터리입니다. 호스트가 없으면 만듭니다. */
  readonly dataDir: string
  /** 자료库 경로를 이 디렉터리 안으로 제한합니다. 생략하면 제한하지 않습니다. */
  readonly libraryRoot?: string
  /** shell 명령의 기준 디렉터리입니다. 생략하면 `dataDir`을 쓿니다. */
  readonly shellCwd?: string
}

export interface NodeHostOptions {
  readonly plugins?: readonly AgentPluginOptions[]
  /** Bundled optional features default to enabled; deployment manifests remain operator-owned. */
  readonly bundledPlugins?: BundledPluginSelection
  readonly mcpServers?: readonly McpClientConfig[]
  readonly provider: AgentHostProvider
  readonly apiKey: string
  /** 기본 모델 ID입니다. `models`에 포함되어야 합니다. */
  readonly model: string
  /** 사용할 수 있는 모델과 한도입니다. */
  readonly models?: Readonly<Record<string, Omit<AgentHostModel, 'id' | 'provider'>>>
  readonly sqlitePath: string
  readonly maxOutputTokens?: number
  readonly tools?: readonly ExecutableTool[] | ToolProvider
  readonly defaultTools?: readonly ExecutableTool[] | ToolProvider
  readonly subagents?: boolean
  readonly maxActiveSubagents?: number
  readonly maxToolRounds?: number
  readonly baseURL?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly runtimePlugins?: RuntimePluginManifest
  readonly runtimePluginBasePath?: string
  readonly pluginConfigPath?: string
  readonly requireProviderApiKey?: boolean
  /** 값을 주면 미디어 플러그인을 자료库·도구·다운로드 순서로 조립합니다. */
  readonly media?: NodeMediaOptions
}

export type HostComposition = Pick<AgentHostOptions, 'setup' | 'mountAgent' | 'toolCatalog'> & {
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
  options: Pick<
    NodeHostOptions,
    | 'tools'
    | 'defaultTools'
    | 'plugins'
    | 'subagents'
    | 'maxActiveSubagents'
    | 'runtimePlugins'
    | 'runtimePluginBasePath'
    | 'bundledPlugins'
  > & {
    compose: HostCompositionFactory
  }
): Promise<AgentRuntime> {
  const provider = (env.KEUNDAL_PROVIDER ||
    (env.OPENAI_API_KEY ? 'openai' : env.GEMINI_API_KEY ? 'gemini' : 'anthropic')) as AgentHostProvider
  const apiKey =
    provider === 'openai' || provider === 'openai-chat'
      ? env.OPENAI_API_KEY
      : provider === 'gemini'
        ? env.GEMINI_API_KEY
        : provider === 'anthropic'
          ? env.ANTHROPIC_API_KEY
          : undefined
  const model = env.KEUNDAL_MODEL
  if (!model?.trim()) throw new Error('KEUNDAL_MODEL 환경 변수를 설정하세요.')
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
  const mediaDir = env.KEUNDAL_MEDIA_DIR?.trim()
  const libraryRoot = env.KEUNDAL_LIBRARY_DIR?.trim()
  const host = await createNodeAgentHost(
    {
      tools: options.tools,
      defaultTools: options.defaultTools,
      subagents: options.subagents,
      maxActiveSubagents: options.maxActiveSubagents,
      plugins: options.plugins,
      bundledPlugins: options.bundledPlugins,
      runtimePlugins: options.runtimePlugins,
      runtimePluginBasePath: options.runtimePluginBasePath,
      pluginConfigPath: env.KEUNDAL_PLUGIN_CONFIG,
      requireProviderApiKey: !env.KEUNDAL_PROVIDER,
      mcpServers: env.KEUNDAL_MCP_SERVERS ? JSON.parse(env.KEUNDAL_MCP_SERVERS) : [],
      provider,
      apiKey: apiKey ?? '',
      model,
      models: { [model]: { contextWindow, maxOutputTokens } },
      sqlitePath,
      maxOutputTokens,
      ...(mediaDir
        ? {
            media: {
              dataDir: mediaDir,
              ...(libraryRoot ? { libraryRoot } : {})
            }
          }
        : {}),
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
