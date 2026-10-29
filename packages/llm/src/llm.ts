import type { ExecutionOptions } from '@keundal/core'
import type { AGUIEvent, RunAgentInput } from '@keundal/core'
import { Service } from 'cordis'
import type { Context } from 'cordis'

export type LLMEvent = Exclude<AGUIEvent, { type: 'RUN_STARTED' | 'RUN_FINISHED' | 'RUN_ERROR' }>

export const LLM_SOURCE_EVENT = 'keundal.source'

export interface LLMSource {
  readonly id: string
  readonly url: string
  readonly title?: string
}

export interface LLMModel {
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly capabilities?: {
    readonly tools?: boolean
    readonly reasoning?: readonly Reasoning[]
    readonly webSearch?: boolean
  }
}

/** 모델 목록의 메타데이터입니다. 생성 지원 여부와 설정된 한도를 보장하지 않습니다. */
export interface LLMModelInfo {
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  /** USD per million tokens; absent prices are unknown, not zero. */
  readonly cost?: {
    readonly input?: number
    readonly output?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
  }
  readonly capabilities?: LLMModel['capabilities']
}

export type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Reasoning = boolean | ReasoningLevel

export function parseReasoning(value: unknown): Reasoning | undefined {
  if (
    value === undefined ||
    typeof value === 'boolean' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
    return value
  throw new Error('reasoning must be a boolean or low, medium, high, xhigh, max')
}

export function parseModelCapabilities(value: unknown): LLMModel['capabilities'] {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('model capabilities must be an object')
  if (Reflect.ownKeys(value).some((key) => key !== 'tools' && key !== 'reasoning' && key !== 'webSearch'))
    throw new Error('unknown model capability')
  const capabilities = value as Record<string, unknown>
  for (const key of ['tools', 'webSearch']) {
    if (capabilities[key] !== undefined && typeof capabilities[key] !== 'boolean')
      throw new Error(`model capability ${key} must be a boolean`)
  }
  let reasoning: Reasoning[] | undefined
  if (capabilities.reasoning !== undefined) {
    if (!Array.isArray(capabilities.reasoning)) throw new Error('model capability reasoning must be an array')
    reasoning = Array.from(capabilities.reasoning, (entry) => {
      const parsed = parseReasoning(entry)
      if (parsed === undefined) throw new Error('model capability reasoning entries must not be undefined')
      return parsed
    })
  }
  return {
    ...(capabilities.tools === undefined ? {} : { tools: capabilities.tools as boolean }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(capabilities.webSearch === undefined ? {} : { webSearch: capabilities.webSearch as boolean })
  }
}

export interface LLMRequest {
  readonly input: RunAgentInput
  readonly model: string
  readonly maxOutputTokens: number
  readonly webSearch?: boolean
  readonly reasoning?: Reasoning
}

export abstract class LLMService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  abstract getModel(model: string, options?: ExecutionOptions): Promise<LLMModel>

  abstract countTokens(request: LLMRequest, options?: ExecutionOptions): Promise<number>

  abstract stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterable<LLMEvent>
}

declare module 'cordis' {
  interface Context {
    readonly llm: LLMService
  }
}
