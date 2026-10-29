import type { ExecutionOptions } from '@keundal/core'
import type { LLMSettings } from '@keundal/llm-settings'
import type { McpOAuthManager, McpProbeResult, McpRequestOptions } from '@keundal/mcp'
import type { ScopedMemoryService } from '@keundal/memory'
import type { SkillProvider, SkillSummary } from '@keundal/skill'
import type { TaskService } from '@keundal/task'
import type { CodingWorkspaceClient } from '@keundal/workspace'

import type { ChatStoreLike } from './chat-store'
import type { ModelOption } from './models'
import type { SkillManager } from './skills'

export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
export const LLM_SETTINGS_KEY = 'keundal:llm-settings'
export interface SettingsStorage {
  load(): Promise<LLMSettings>
  save(settings: LLMSettings): Promise<void>
  subscribe?(listener: (settings: LLMSettings) => void): () => void
}
export type ModelLoader = (
  provider: string,
  settings: LLMSettings,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  options?: { force?: boolean; signal?: AbortSignal }
) => Promise<ModelOption[]>
export interface ChatConnection {
  store: ChatStoreLike
  memory?: Pick<ScopedMemoryService, 'list' | 'save' | 'delete'> & {
    search(
      query: Parameters<ScopedMemoryService['search']>[0] & { model?: string }
    ): ReturnType<ScopedMemoryService['search']>
  }
  workspaces?: CodingWorkspaceClient
  tasks?: Pick<TaskService, 'list' | 'get' | 'cancel'>
  remoteAgent: boolean
  remoteModels?: ModelOption[]
  selectedModel?: string
  selectModel?: (value: string) => Promise<void>
  catalog?(options?: ExecutionOptions): Promise<{ skills: readonly SkillSummary[]; tools: readonly SkillSummary[] }>
  mcpChanged?: () => Promise<void>
  settingsChanged?: (next: LLMSettings) => Promise<void>
  dispose(): Promise<void>
}
export interface ChatConnectionOptions {
  getSettings(): LLMSettings
  getModels(): ModelOption[]
  initialModel?: string
  skills: readonly SkillProvider[]
}
export interface AgentPluginSettings {
  enabled: boolean
  permissions: Record<string, import('@keundal/mcp').McpPermissions>
}
export interface AgentPluginInfo extends AgentPluginSettings {
  name: string
  version?: string
  description?: string
  skills: string[]
  servers: { name: string; url: string }[]
  diagnostics: { component: string; entry?: string; message: string }[]
}
export interface AgentPluginUpdate {
  id: string
  name: string
  previousVersion?: string
  version?: string
  changes: { path: string; before?: string; after?: string }[]
  /** New or changed server connections need fresh approval, even if their names are unchanged. */
  permissionRequests: { name: string; url: string; previousUrl?: string }[]
  diagnostics: AgentPluginInfo['diagnostics']
}
export interface AgentPluginManager {
  list(): Promise<AgentPluginInfo[]>
  import(files: Record<string, string>, restart: () => Promise<void>): Promise<void>
  previewUpdate(name: string, files: Record<string, string>): Promise<AgentPluginUpdate>
  update(id: string, permissions: AgentPluginSettings['permissions'], restart: () => Promise<void>): Promise<void>
  configure(name: string, settings: AgentPluginSettings, restart: () => Promise<void>): Promise<void>
  remove(name: string, restart: () => Promise<void>): Promise<void>
}
export interface RuntimePluginSource {
  type: 'npm' | 'jsr' | 'zip' | 'path'
  value: string
}
export interface RuntimePluginInfo {
  module: string
  source?: RuntimePluginSource
  version?: string
  /** Plugin-owned display copy; module remains the stable selection identifier. */
  metadata?: {
    name: { en: string; ko: string }
    description: { en: string; ko: string }
  }
  enabled: boolean
  /** Module identifiers required for this plugin to operate. */
  requires?: readonly string[]
  /** Disabled dependencies; the saved enabled selection is retained. */
  blockedBy?: readonly string[]
  /** Service capability used to bind related UI without depending on implementation packages. */
  feature?: 'skills' | 'mcp' | 'prompt' | 'subagents' | 'agent'
  required?: boolean
  error?: string
}
export interface RuntimePluginManager {
  list(): Promise<RuntimePluginInfo[]>
  setEnabled(module: string, enabled: boolean): Promise<void>
  /** Only local desktop hosts expose external code installation. Installs start disabled. */
  install?(source: RuntimePluginSource): Promise<void>
  remove?(module: string): Promise<void>
}
export type TranscriptEvent =
  | { type: 'transcript-delta'; delta: string }
  | { type: 'transcript-partial' | 'transcript-final'; text: string }
export interface TranscriptionStream {
  fullStream: AsyncIterable<TranscriptEvent>
  text: Promise<string>
}
export interface ChatPlatform {
  plugins?: AgentPluginManager
  runtimePlugins?: RuntimePluginManager
  mcp: {
    readonly configuration: import('@keundal/mcp').McpClientConfig[]
    readonly oauth?: McpOAuthManager
    load(): Promise<void>
    save(value: unknown, restart: () => Promise<void>): Promise<void>
    /** Checks an unsaved configuration over a temporary connection; absent when the platform cannot do it. */
    probe?(value: unknown, options?: McpRequestOptions): Promise<McpProbeResult>
    close(): Promise<void>
  }
  settings: SettingsStorage
  skills: SkillManager
  loadModels: ModelLoader
  connect(options: ChatConnectionOptions): Promise<ChatConnection>
  transcription: {
    sampleRate: number
    start(settings: LLMSettings, audio: ReadableStream<Float32Array>, signal: AbortSignal): Promise<TranscriptionStream>
  }
}
