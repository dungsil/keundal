import type { ExecutionOptions, SkillProvider, SkillSummary } from '@keundal/core'
import type { LLMSettings } from '@keundal/llm-settings'

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
export type TranscriptEvent =
  | { type: 'transcript-delta'; delta: string }
  | { type: 'transcript-partial' | 'transcript-final'; text: string }
export interface TranscriptionStream {
  fullStream: AsyncIterable<TranscriptEvent>
  text: Promise<string>
}
export interface ChatPlatform {
  mcp: {
    readonly configuration: import('@keundal/mcp').McpClientConfig[]
    load(): Promise<void>
    save(value: unknown, restart: () => Promise<void>): Promise<void>
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
