import { compact, SummaryCompactionConfigSchema, type SummaryCompactionConfig } from '@keundal/compaction'
import {
  EventType,
  parseRunAgentInput,
  type AGUIEvent,
  type CompactionResult,
  type ExecutionOptions,
  type RunAgentInput
} from '@keundal/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Service, type Context } from 'cordis'

import { SYSTEM_PROMPT_ID, withSystemPrompt } from './prompt.js'
import { SKILL_CATALOG_ID, skillTool, withSkillCatalog } from './skills.js'
import { addTools, parseTools, streamWithTools, type ExecutableTool } from './tools.js'

export type { ExecutableTool, ToolExecutionContext } from './tools.js'

export const STEERING_EVENT = 'keundal.steering'
export const STEER_EVENT = STEERING_EVENT
export const FOLLOW_UP_EVENT = STEERING_EVENT
export const QUEUE_EVENT = STEERING_EVENT

export type ToolProvider = (options: ExecutionOptions) => readonly ExecutableTool[] | Promise<readonly ExecutableTool[]>

export interface AgentConfig {
  readonly model: string
  readonly maxOutputTokens: number
  readonly webSearch?: boolean
  readonly reasoning?: boolean
  readonly compaction?: SummaryCompactionConfig
  readonly tools?: readonly ExecutableTool[] | ToolProvider
  readonly skills?: boolean
  /** 모든 실행에 앞서 모델에 전달할 시스템 지침입니다. */
  readonly systemPrompt?: string
  /** 도구를 실행하고 후속 생성을 요청할 최대 횟수입니다. 기본값은 8입니다. */
  readonly maxToolRounds?: number
  /** 같은 응답의 도구 실행을 겹쳐 시작합니다. 기본값은 false로 순차 실행입니다. */
  readonly parallelTools?: boolean
  readonly steering?: 'steer' | 'follow-up' | 'followUp' | 'followup' | 'reject'
  readonly inputPolicy?: 'steer' | 'follow-up' | 'followUp' | 'followup' | 'reject'
  readonly queuePolicy?: 'steer' | 'follow-up' | 'followUp' | 'followup' | 'reject'
  readonly steeringPolicy?: 'steer' | 'follow-up' | 'followUp' | 'followup' | 'reject'
}

/**
 * 에이전트 설정을 검증하고 기본값을 채웁니다. 잘못된 값은 예외로 알립니다.
 */
export function parseAgentConfig(value: unknown): AgentConfig {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('model' in value) ||
    typeof value.model !== 'string' ||
    !value.model.trim() ||
    !('maxOutputTokens' in value) ||
    typeof value.maxOutputTokens !== 'number' ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    value.maxOutputTokens <= 0
  ) {
    throw new Error('model and a positive integer maxOutputTokens are required')
  }
  const compaction = SummaryCompactionConfigSchema['~standard'].validate(
    'compaction' in value ? value.compaction : undefined
  )
  if (compaction.issues)
    throw new Error(compaction.issues.map((issue) => issue.message).join('; ') || 'invalid compaction config')
  for (const key of ['webSearch', 'reasoning', 'skills'] as const) {
    const option = (value as Record<string, unknown>)[key]
    if (option !== undefined && typeof option !== 'boolean') {
      throw new Error(`${key} must be a boolean`)
    }
  }
  const configuredTools = 'tools' in value ? value.tools : undefined
  const tools = typeof configuredTools === 'function' ? (configuredTools as ToolProvider) : parseTools(configuredTools)
  const skills = 'skills' in value ? (value.skills as boolean | undefined) : undefined
  if (skills && typeof tools !== 'function' && tools.some((tool) => tool.name === 'skill'))
    throw new Error('skill tool name is reserved when skills are enabled')
  const systemPrompt = 'systemPrompt' in value ? value.systemPrompt : undefined
  if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || !systemPrompt.trim())) {
    throw new Error('systemPrompt must be a non-empty string')
  }
  const maxToolRounds = 'maxToolRounds' in value ? value.maxToolRounds : 8
  if (typeof maxToolRounds !== 'number' || !Number.isSafeInteger(maxToolRounds) || maxToolRounds <= 0) {
    throw new Error('maxToolRounds must be a positive integer')
  }
  const parallelTools = 'parallelTools' in value ? value.parallelTools : false
  if (typeof parallelTools !== 'boolean') throw new Error('parallelTools must be a boolean')
  const normalizePolicy = (raw: unknown): 'steer' | 'follow-up' | 'reject' => {
    if (raw === 'followUp' || raw === 'followup') return 'follow-up'
    if (raw === 'steer' || raw === 'follow-up' || raw === 'reject') return raw
    throw new Error('steering policy must be steer, follow-up or reject')
  }
  const policyRaw =
    'steering' in value
      ? value.steering
      : 'inputPolicy' in value
        ? value.inputPolicy
        : 'queuePolicy' in value
          ? value.queuePolicy
          : 'steeringPolicy' in value
            ? value.steeringPolicy
            : undefined
  const steering = policyRaw === undefined ? undefined : normalizePolicy(policyRaw)
  return {
    model: value.model,
    maxOutputTokens: value.maxOutputTokens,
    ...('webSearch' in value ? { webSearch: value.webSearch as boolean | undefined } : {}),
    ...('reasoning' in value ? { reasoning: value.reasoning as boolean | undefined } : {}),
    compaction: compaction.value,
    tools,
    skills,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    maxToolRounds,
    parallelTools,
    ...(steering === undefined
      ? {}
      : { steering, inputPolicy: steering, queuePolicy: steering, steeringPolicy: steering })
  }
}

const agentConfigSchema: StandardSchemaV1<AgentConfig, AgentConfig> = {
  '~standard': {
    version: 1,
    vendor: 'keundal',
    validate(value) {
      try {
        return { value: parseAgentConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : 'invalid agent config' }] }
      }
    }
  }
}

declare module 'cordis' {
  interface Context {
    readonly agent: Agent
  }
}

/**
 * 에이전트 구현의 계약입니다. 도구 실행, 후속 생성, 축약, 스킬을 함께 처리하는 기본 구현을
 * 담고, 다른 에이전트 구현은 이 클래스를 확장해 동작을 바꾼다.
 */
export class Agent extends Service {
  private readonly active = new Set<AbortController>()
  private closed = false
  private readonly steeringQueue: RunAgentInput[] = []
  private readonly followUpQueue: RunAgentInput[] = []
  private activeRun: { threadId: string; runId: string } | undefined

  constructor(
    ctx: Context,
    protected readonly config: AgentConfig
  ) {
    super(ctx, 'agent')
    ctx.fiber.effect(() => () => {
      this.closed = true
      for (const controller of this.active) controller.abort(new Error('agent disposed'))
    })
  }

  private inputPolicy(): 'steer' | 'follow-up' | 'reject' {
    return (this.config.steering ??
      this.config.inputPolicy ??
      this.config.queuePolicy ??
      this.config.steeringPolicy ??
      'reject') as 'steer' | 'follow-up' | 'reject'
  }

  private normalizeQueuedInput(input: unknown): RunAgentInput {
    if (Array.isArray(input)) {
      if (!this.activeRun) throw new Error('agent has no active run')
      return parseRunAgentInput({
        threadId: this.activeRun.threadId,
        runId: this.activeRun.runId,
        state: {},
        messages: input,
        tools: [],
        context: []
      })
    }
    if (input && typeof input === 'object' && 'role' in (input as Record<string, unknown>)) {
      if (!this.activeRun) throw new Error('agent has no active run')
      return parseRunAgentInput({
        threadId: this.activeRun.threadId,
        runId: this.activeRun.runId,
        state: {},
        messages: [input],
        tools: [],
        context: []
      })
    }
    return parseRunAgentInput(input)
  }

  steer(input: unknown): 'queued' {
    if (this.closed) throw new Error('agent disposed')
    this.steeringQueue.push(this.normalizeQueuedInput(input))
    return 'queued'
  }

  followUp(input: unknown): 'queued' {
    if (this.closed) throw new Error('agent disposed')
    this.followUpQueue.push(this.normalizeQueuedInput(input))
    return 'queued'
  }

  pendingInputs(): { steering: number; followUp: number } {
    return { steering: this.steeringQueue.length, followUp: this.followUpQueue.length }
  }

  pending(): { steering: number; followUp: number } {
    return this.pendingInputs()
  }

  queued(): { steering: number; followUp: number } {
    return this.pendingInputs()
  }

  enqueue(input: unknown, mode: 'steer' | 'follow-up' | 'followUp' | 'followup' | 'reject' = 'steer'): 'queued' {
    if (mode === 'follow-up' || mode === 'followUp' || mode === 'followup') return this.followUp(input)
    if (mode === 'steer') return this.steer(input)
    throw new Error('agent is already running')
  }

  queue(input: unknown, mode: 'steer' | 'follow-up' | 'followUp' | 'followup' | 'reject' = 'steer'): 'queued' {
    return this.enqueue(input, mode)
  }

  takeSteeringInputs(): RunAgentInput[] {
    const taken = [...this.steeringQueue]
    this.steeringQueue.length = 0
    return taken
  }

  private async *queuedIterator(policy: 'steer' | 'follow-up'): AsyncGenerator<AGUIEvent, void, unknown> {
    yield {
      type: EventType.CUSTOM,
      name: 'keundal.steering',
      value: { status: 'queued', policy }
    }
  }

  /**
   * 모든 실행에 앞서 모델에 전달할 시스템 지침입니다. 구현은 이 값을 바꿀 수 있습니다.
   */
  protected systemPrompt(): string | undefined {
    return this.config.systemPrompt
  }

  run(input: RunAgentInput, options: ExecutionOptions = {}): AsyncIterableIterator<AGUIEvent> {
    if (this.closed) throw new Error('agent disposed')
    if (this.active.size > 0) {
      const requested =
        (options as Record<string, unknown>).steering ??
        (options as Record<string, unknown>).mode ??
        (options as Record<string, unknown>).policy ??
        (options as Record<string, unknown>).queue
      const policy =
        requested === undefined
          ? this.inputPolicy()
          : requested === 'followUp' || requested === 'followup'
            ? 'follow-up'
            : (requested as 'steer' | 'follow-up' | 'reject')
      if (policy === 'steer') {
        this.steer(input)
        return this.queuedIterator('steer')
      }
      if (policy === 'follow-up') {
        this.followUp(input)
        return this.queuedIterator('follow-up')
      }
      throw new Error('agent is already running')
    }
    const controller = new globalThis.AbortController()
    const externalSignal = options.signal
    const abort = () => controller.abort(externalSignal?.reason)
    const cleanup = () => {
      externalSignal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', cleanup)
      this.active.delete(controller)
    }
    this.active.add(controller)
    controller.signal.addEventListener('abort', cleanup, { once: true })
    if (externalSignal?.aborted) abort()
    else externalSignal?.addEventListener('abort', abort, { once: true })

    const stop = () => {
      if (!controller.signal.aborted) controller.abort(new Error('agent run stopped'))
      cleanup()
    }
    const iterator = this.execute(input, controller.signal, stop)
    return {
      next: () => iterator.next(),
      return: async () => {
        stop()
        return iterator.return(undefined)
      },
      throw: async (reason?: unknown) => {
        stop()
        return iterator.throw(reason)
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }

  private async *execute(
    input: RunAgentInput,
    signal: AbortSignal,
    cleanup: () => void
  ): AsyncGenerator<AGUIEvent, void, unknown> {
    try {
      signal.throwIfAborted()
      let currentInput: RunAgentInput = input
      while (true) {
        signal.throwIfAborted()
        const request = parseRunAgentInput(currentInput)
        this.activeRun = { threadId: request.threadId, runId: request.runId }
        for (const reserved of [SKILL_CATALOG_ID, SYSTEM_PROMPT_ID]) {
          if (request.messages.some((message) => message.id === reserved)) {
            throw new Error(`message id is reserved: ${reserved}`)
          }
        }
        const options = { signal }
        const prepared = await this.ctx.session.prepare(request, options)
        signal.throwIfAborted()
        const configuredTools = parseTools(
          typeof this.config.tools === 'function' ? await this.config.tools(options) : this.config.tools
        )
        signal.throwIfAborted()
        if (this.config.skills && configuredTools.some((tool) => tool.name === 'skill'))
          throw new Error('skill tool name is reserved when skills are enabled')
        const catalog = this.config.skills ? await this.ctx.skills.prepare(options) : undefined
        signal.throwIfAborted()
        const tools = [...configuredTools, ...(catalog ? [skillTool(catalog)] : [])]
        const preparedInput = addTools(
          withSystemPrompt(withSkillCatalog(parseRunAgentInput(prepared.input), catalog), this.systemPrompt()),
          tools
        )
        if (preparedInput.threadId !== request.threadId || preparedInput.runId !== request.runId) {
          throw new Error('session preparation must preserve threadId and runId')
        }
        if (!Number.isSafeInteger(prepared.revision) || prepared.revision < 0) {
          throw new Error('session revision must be a non-negative integer')
        }

        const model = await this.ctx.llm.getModel(this.config.model, options)
        signal.throwIfAborted()
        const maxOutputTokens = this.config.maxOutputTokens
        if (
          !Number.isSafeInteger(model.contextWindow) ||
          !Number.isSafeInteger(model.maxOutputTokens) ||
          maxOutputTokens > model.maxOutputTokens ||
          maxOutputTokens >= model.contextWindow
        ) {
          throw new Error('requested output budget exceeds the model limits')
        }
        const maxInputTokens = model.contextWindow - maxOutputTokens
        const fitted = await this.fitInput(preparedInput, maxInputTokens, signal)

        signal.throwIfAborted()
        yield* this.ctx.generation.run(
          {
            input: fitted.input,
            model: this.config.model,
            maxOutputTokens,
            ...(this.config.webSearch === undefined ? {} : { webSearch: this.config.webSearch }),
            ...(this.config.reasoning === undefined ? {} : { reasoning: this.config.reasoning }),
            sessionRevision: prepared.revision,
            ...(fitted.compaction ? { compaction: fitted.compaction } : {})
          },
          {
            signal,
            ...(tools.length
              ? {
                  stream: (request, execution) => {
                    const generationSignal = execution?.signal ?? signal
                    return streamWithTools(
                      this.ctx.llm,
                      request,
                      tools,
                      this.config.maxToolRounds ?? 8,
                      async (next) => (await this.fitInput(next, maxInputTokens, generationSignal)).input,
                      generationSignal,
                      { parallel: this.config.parallelTools ?? false },
                      () => this.takeSteeringInputs()
                    )
                  }
                }
              : {})
          }
        )
        if (this.followUpQueue.length > 0) {
          currentInput = this.followUpQueue.shift()!
          continue
        }
        break
      }
    } finally {
      this.activeRun = undefined
      cleanup()
    }
  }

  private async fitInput(
    input: RunAgentInput,
    maxInputTokens: number,
    signal: AbortSignal
  ): Promise<{ input: RunAgentInput; compaction?: CompactionResult }> {
    signal.throwIfAborted()
    const countTokens = async (candidate: RunAgentInput) => {
      const count = await this.ctx.llm.countTokens(
        {
          input: candidate,
          model: this.config.model,
          maxOutputTokens: this.config.maxOutputTokens,
          ...(this.config.webSearch === undefined ? {} : { webSearch: this.config.webSearch }),
          ...(this.config.reasoning === undefined ? {} : { reasoning: this.config.reasoning })
        },
        { signal }
      )
      signal.throwIfAborted()
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid input token count')
      return count
    }

    const count = await countTokens(input)
    if (count <= maxInputTokens) return { input }

    const compaction = await compact(
      this.ctx.llm,
      {
        input,
        model: this.config.model,
        maxInputTokens
      },
      { ...this.config.compaction, signal, inputTokens: count }
    )
    signal.throwIfAborted()
    const compacted = { ...input, messages: compaction.messages }
    // 축약기의 기본 계산과 달리 네이티브 검색 도구의 입력 비용까지 포함해 다시 검사합니다.
    if (
      (this.config.webSearch !== undefined || this.config.reasoning !== undefined) &&
      (await countTokens(compacted)) > maxInputTokens
    )
      throw new Error('compacted input exceeds the model input budget')
    return { input: compacted, compaction }
  }
}

/** 에이전트 구현이 지켜야 할 생성자 계약입니다. */
export type AgentImplementation = new (ctx: Context, config: AgentConfig) => Agent

/**
 * 에이전트 구현을 `ctx.agent`로 등록합니다. 스킬을 켜면 `skills` 서비스를 기다리는 동안 에이전트를
 * 준비하고, 서비스가 사라지면 진행 중 실행을 취소합니다.
 */
export function registerAgent(ctx: Context, config: AgentConfig, implementation: AgentImplementation = Agent): void {
  if (config.skills) {
    ctx.inject(['skills'], (skillsCtx) => {
      new implementation(skillsCtx, config)
    })
  } else {
    new implementation(ctx, config)
  }
}

export const agentPlugin = Object.assign(
  function agentPlugin(ctx: Context, config: AgentConfig) {
    registerAgent(ctx, config)
  },
  { inject: ['llm', 'generation', 'session'], Config: agentConfigSchema }
)

export { agentConfigSchema as AgentConfigSchema }
export default agentPlugin
