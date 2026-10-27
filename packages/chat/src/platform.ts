import type { ExecutionOptions, SkillProvider, SkillSummary } from '@keundal/core'
import type { LLMSettings } from '@keundal/llm-settings'
import type { McpProbeResult, McpRequestOptions } from '@keundal/mcp'
import type {
  ExportClipsRequest,
  ExportFcpxmlRequest,
  ExportFcpxmlResult,
  ImportMediaEntry,
  MediaDownloadJob,
  MediaDownloadRequest,
  MediaExportFile,
  MediaItem,
  MediaLibrary,
  MediaToolName,
  MediaToolStatus,
  SubtitleTrack,
  TranslateSubtitlesRequest,
  TranslateSubtitlesResult
} from '@keundal/media'
import type { SpeechModelStatus, TranscribeMediaRequest, TranscribeMediaResult } from '@keundal/transcription'

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
export interface AgentPluginManager {
  list(): Promise<AgentPluginInfo[]>
  import(files: Record<string, string>, restart: () => Promise<void>): Promise<void>
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
  /** Service capability used to bind related UI without depending on implementation packages. */
  feature?: 'skills' | 'mcp'
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
/**
 * 자료库와 로컬 미디어 도구를 다루는 플랫폼 표면입니다.
 * 호스트가 미디어 기능을 조립하지 않았으면 플랫폼은 이 값을 제공하지 않습니다.
 */
export interface PlatformMedia {
  tools(): Promise<readonly MediaToolStatus[]>
  installTool(name: MediaToolName): Promise<MediaToolStatus>
  configureTool(name: MediaToolName, path: string | null): Promise<void>
  models(): Promise<readonly SpeechModelStatus[]>
  installModel(id: string): Promise<SpeechModelStatus>
  createLibrary(request: { path: string; name?: string }): Promise<MediaLibrary>
  openLibrary(path: string): Promise<MediaLibrary>
  items(path: string): Promise<readonly MediaItem[]>
  /** `<video src>`에 넣을 수 있는 주소를 만듭니다. 토큰이 쿼리에 붙습니다. */
  videoUrl(request: { libraryPath: string; itemId: string }): Promise<string>
  importMedia(request: { libraryPath: string; entries: readonly ImportMediaEntry[] }): Promise<readonly MediaItem[]>
  removeItem(request: { libraryPath: string; itemId: string; permanent?: boolean }): Promise<void>
  saveSubtitle(request: { libraryPath: string; itemId: string; track: SubtitleTrack }): Promise<void>
  startDownload(request: MediaDownloadRequest): Promise<MediaDownloadJob>
  downloads(): Promise<readonly MediaDownloadJob[]>
  controlDownload(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<void>
  transcribe(request: TranscribeMediaRequest): Promise<TranscribeMediaResult>
  translate(request: TranslateSubtitlesRequest): Promise<TranslateSubtitlesResult>
  exportClips(request: ExportClipsRequest): Promise<readonly MediaExportFile[]>
  exportFcpxml(request: ExportFcpxmlRequest): Promise<ExportFcpxmlResult>
}

export interface ChatPlatform {
  plugins?: AgentPluginManager
  runtimePlugins?: RuntimePluginManager
  /** 호스트가 미디어 경로를 제공할 때만 있습니다. */
  media?: PlatformMedia
  mcp: {
    readonly configuration: import('@keundal/mcp').McpClientConfig[]
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
