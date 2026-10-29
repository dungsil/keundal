import process from 'node:process'

import { createAgentHost, type AgentHostModel, type AgentHostOptions, type AgentHost } from '@keundal/agent-host'
import { createAgentApp, type AgentAppOptions } from '@keundal/agent-host/http'
import type { AgentPluginOptions, LoadedAgentPlugin } from '@keundal/agent-plugins'
import { NodeAutomationService } from '@keundal/automation-node'
import type { McpAuthentication, McpClientConfig } from '@keundal/mcp'
import { listMockModels } from '@keundal/plugin-llm-mock'
import { WebhookNotificationService, type WebhookNotificationOptions } from '@keundal/plugin-notification-webhook'
import type { RuntimePluginManifest } from '@keundal/plugin-runtime'
import { ToolApproval, type ToolApprovalPolicy } from '@keundal/tool-approval'
import type { ExecutableTool, ToolProvider } from '@keundal/tools'

export {
  createNodeComposition,
  getRequiredNodePluginModules,
  getConfiguredNodePluginModules,
  nodePluginMetadata
} from './default-composition.js'

export type AgentHostProvider = 'openai' | 'gemini' | 'anthropic' | 'mock' | (string & {})

export type BundledPluginModule =
  | '@keundal/prompt'
  | '@keundal/subagent'
  | '@keundal/plugin-agent-chat'
  | '@keundal/plugin-skill'
  | '@keundal/plugin-mcp-client'
  | '@keundal/plugin-tool-chart'
  | '@keundal/plugin-tool-todo'
  | '@keundal/plugin-tool-weather'
  /** Legacy preference used only as a fallback for the split tool selections. */
  | '@keundal/plugin-tool-chat'
export type BundledPluginSelection = Readonly<Partial<Record<BundledPluginModule, boolean>>> &
  Readonly<Record<string, boolean | undefined>>

export interface NodeHostOptions {
  readonly toolApproval?: ToolApprovalPolicy
  /** Defaults to enabled when the composition supplies tasks and automationStore. */
  readonly automation?: boolean
  /** Operator-owned outbound destination; credentials are never saved with automations. */
  readonly notificationWebhook?: WebhookNotificationOptions
  readonly plugins?: readonly AgentPluginOptions[]
  /** Bundled optional features default to enabled; deployment manifests remain operator-owned. */
  readonly bundledPlugins?: BundledPluginSelection
  readonly mcpServers?: readonly McpClientConfig[]
  /** Live per-user account controllers; never serialized into environment/server settings. */
  readonly mcpAuthentication?: Readonly<Record<string, McpAuthentication>>
  readonly provider: AgentHostProvider
  readonly apiKey: string
  /** 기본 모델 ID입니다. `models`에 포함되어야 합니다. */
  readonly model: string
  /** 사용할 수 있는 모델과 한도입니다. */
  readonly models?: Readonly<Record<string, Omit<AgentHostModel, 'id' | 'provider'>>>
  readonly sqlitePath: string
  /** Stable project scope for opt-in persistent memory tools. Omit to leave them disabled. */
  readonly projectId?: string
  /** Durable workspace state outside selected repositories. */
  readonly workspaceRoot?: string
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
}

export type HostComposition = Pick<AgentHostOptions, 'setup' | 'mountAgent' | 'toolCatalog' | 'workspaces'> & {
  plugins?: readonly LoadedAgentPlugin[]
}
export type HostCompositionFactory = (options: NodeHostOptions) => HostComposition

export async function createNodeAgentHost(options: NodeHostOptions, compose: HostCompositionFactory) {
  const models =
    options.models ??
    Object.fromEntries(
      (options.provider === 'mock' ? (await listMockModels()).map((model) => model.id) : [options.model]).map((id) => [
        id,
        { contextWindow: 128000, maxOutputTokens: 4096 }
      ])
    )
  const composition = compose({ ...options, models })
  const host = await createAgentHost({
    ...(options.toolApproval === undefined ? {} : { toolApproval: new ToolApproval(options.toolApproval) }),
    model: options.model,
    models: Object.entries(models).map(([id, limits]) => ({ id, provider: options.provider, ...limits })),
    maxOutputTokens: options.maxOutputTokens,
    ...composition
  })
  let automation: NodeAutomationService | undefined
  let notification: WebhookNotificationService | undefined
  try {
    if (options.notificationWebhook) {
      if (!host.ctx.notificationStore) throw new Error('notification Webhook requires a notificationStore')
      notification = new WebhookNotificationService(host.ctx, host.ctx.notificationStore, options.notificationWebhook)
      notification.start()
    }
    if (options.automation !== false && host.ctx.tasks && host.ctx.automationStore) {
      automation = new NodeAutomationService(host.ctx, {
        store: host.ctx.automationStore,
        tasks: host.ctx.tasks,
        notification: host.ctx.notification,
        run: (input, execution) => host.services.run(input, execution)
      })
      await automation.start()
    }
    return {
      ...host,
      services: { ...host.services, ...(automation ? { automation } : {}) },
      plugins: composition.plugins ?? [],
      async dispose() {
        await automation?.dispose()
        await notification?.dispose()
        await host.dispose()
      }
    }
  } catch (error) {
    await automation?.dispose()
    await notification?.dispose()
    await host.dispose()
    throw error
  }
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
    | 'automation'
    | 'defaultTools'
    | 'plugins'
    | 'subagents'
    | 'maxActiveSubagents'
    | 'runtimePlugins'
    | 'runtimePluginBasePath'
    | 'bundledPlugins'
    | 'toolApproval'
    | 'mcpAuthentication'
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
  const model = env.KEUNDAL_MODEL || (provider === 'mock' ? 'mock-text' : undefined)
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
  const host = await createNodeAgentHost(
    {
      toolApproval:
        options.toolApproval ?? (env.KEUNDAL_TOOL_APPROVAL ? JSON.parse(env.KEUNDAL_TOOL_APPROVAL) : undefined),
      automation: options.automation,
      notificationWebhook: env.KEUNDAL_NOTIFICATION_WEBHOOK_URL
        ? { url: env.KEUNDAL_NOTIFICATION_WEBHOOK_URL, token: env.KEUNDAL_NOTIFICATION_WEBHOOK_TOKEN }
        : undefined,
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
      mcpAuthentication: options.mcpAuthentication,
      provider,
      apiKey: apiKey ?? '',
      model,
      models: Object.fromEntries(
        (provider === 'mock'
          ? [...new Set([...(await listMockModels()).map((entry) => entry.id), model])]
          : [model]
        ).map((id) => [id, { contextWindow, maxOutputTokens }])
      ),
      sqlitePath,
      projectId: env.KEUNDAL_PROJECT_ID,
      workspaceRoot: env.KEUNDAL_WORKSPACE_ROOT,
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
