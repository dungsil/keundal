import { parseRunBudget, type RunBudget } from '@keundal/agent'
import type { AgentCompactionConfig } from '@keundal/compaction'
import { parseCompactionConfig } from '@keundal/compaction-summary/controller'
import { parseDeferredToolsConfig, type DeferredToolsConfig } from '@keundal/deferred-tools'
import { parseReasoning, type Reasoning } from '@keundal/llm'
import { parseSubagentRoles, type SubagentRole } from '@keundal/subagent'
import { SUBAGENT_TOOL_NAME } from '@keundal/subagent/tools'
import { ToolApproval } from '@keundal/tool-approval'
import { parseTools } from '@keundal/tool-execution'
import type { ExecutableTool, ToolProvider } from '@keundal/tools'
import { parsePricing, type AgentPricing } from '@keundal/trace'
import type { StandardSchemaV1 } from '@standard-schema/spec'

export interface AgentConfig {
  readonly model: string
  readonly maxOutputTokens: number
  readonly budget?: RunBudget
  readonly webSearch?: boolean
  readonly reasoning?: Reasoning
  readonly compaction?: AgentCompactionConfig
  readonly tools?: readonly ExecutableTool[] | ToolProvider
  readonly toolApproval?: ToolApproval
  /** 도구를 검색한 뒤 다음 모델 요청에서만 노출합니다. */
  readonly deferredTools?: DeferredToolsConfig
  /** 지연 도구만 공급합니다. 기존 tools 공급자와 별도로 조회합니다. */
  readonly deferredToolProvider?: ToolProvider
  readonly subagents?: boolean
  readonly maxActiveSubagents?: number
  readonly subagentRoles?: readonly SubagentRole[]
  readonly skills?: boolean
  readonly promptPresets?: boolean
  readonly context?: boolean
  /** 모든 실행에 앞서 모델에 전달할 시스템 지침입니다. */
  readonly systemPrompt?: string
  /** 도구 실행 뒤 후속 생성을 요청할 최대 횟수입니다. 기본값은 8입니다. */
  readonly maxToolRounds?: number
  /** 한 실행에서 허용할 도구 호출의 최대 개수입니다. 기본값은 32입니다. */
  readonly maxToolCalls?: number
  /** 같은 응답의 도구를 병렬로 실행합니다. 기본값은 false입니다. */
  readonly parallelTools?: boolean
  /**
   * 공급자가 비용을 주지 않는 모델 호출의 비용을 `source: 'estimate'`로 추정합니다.
   * 가격표에 없는 모델은 비용을 미확정으로 둡니다.
   */
  readonly pricing?: AgentPricing
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
  const compaction = parseCompactionConfig('compaction' in value ? value.compaction : undefined)
  for (const key of ['webSearch', 'skills', 'context', 'subagents', 'promptPresets'] as const) {
    const option = (value as Record<string, unknown>)[key]
    if (option !== undefined && typeof option !== 'boolean') {
      throw new Error(`${key} must be a boolean`)
    }
  }
  const configuredTools = 'tools' in value ? value.tools : undefined
  const toolApproval = 'toolApproval' in value ? value.toolApproval : undefined
  if (toolApproval !== undefined && !(toolApproval instanceof ToolApproval)) {
    throw new Error('toolApproval must be a host-owned ToolApproval instance')
  }
  const deferredTools =
    'deferredTools' in value && value.deferredTools !== undefined
      ? parseDeferredToolsConfig(value.deferredTools)
      : undefined
  const deferredToolProvider = 'deferredToolProvider' in value ? value.deferredToolProvider : undefined
  if (deferredToolProvider !== undefined && typeof deferredToolProvider !== 'function') {
    throw new Error('deferredToolProvider must be a function')
  }
  if ((deferredToolProvider === undefined) !== (deferredTools === undefined)) {
    throw new Error('deferredTools and deferredToolProvider must be configured together')
  }
  const tools = typeof configuredTools === 'function' ? (configuredTools as ToolProvider) : parseTools(configuredTools)
  const maxActiveSubagents =
    'maxActiveSubagents' in value && value.maxActiveSubagents !== undefined ? value.maxActiveSubagents : 8
  if (typeof maxActiveSubagents !== 'number' || !Number.isSafeInteger(maxActiveSubagents) || maxActiveSubagents <= 0)
    throw new Error('maxActiveSubagents must be a positive integer')
  const subagents = 'subagents' in value ? (value.subagents as boolean | undefined) : undefined
  const subagentRoles =
    'subagentRoles' in value && value.subagentRoles !== undefined ? parseSubagentRoles(value.subagentRoles) : undefined
  if (subagents && typeof tools !== 'function' && tools.some((tool) => tool.name === SUBAGENT_TOOL_NAME))
    throw new Error('delegate_task tool name is reserved when subagents are enabled')
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
  const maxToolCalls = 'maxToolCalls' in value ? value.maxToolCalls : 32
  if (typeof maxToolCalls !== 'number' || !Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) {
    throw new Error('maxToolCalls must be a positive integer')
  }
  const parallelTools = 'parallelTools' in value ? value.parallelTools : false
  if (typeof parallelTools !== 'boolean') throw new Error('parallelTools must be a boolean')
  const pricing = 'pricing' in value && value.pricing !== undefined ? parsePricing(value.pricing) : undefined
  const budget = 'budget' in value && value.budget !== undefined ? parseRunBudget(value.budget) : undefined
  return {
    model: value.model,
    maxOutputTokens: value.maxOutputTokens,
    ...(budget ? { budget } : {}),
    ...('webSearch' in value ? { webSearch: value.webSearch as boolean | undefined } : {}),
    ...('reasoning' in value ? { reasoning: parseReasoning(value.reasoning) } : {}),
    compaction,
    tools,
    ...(toolApproval === undefined ? {} : { toolApproval }),
    ...(deferredTools === undefined ? {} : { deferredTools }),
    ...(deferredToolProvider === undefined ? {} : { deferredToolProvider: deferredToolProvider as ToolProvider }),
    subagents,
    maxActiveSubagents,
    ...(subagentRoles === undefined ? {} : { subagentRoles }),
    skills,
    ...('promptPresets' in value ? { promptPresets: value.promptPresets as boolean | undefined } : {}),
    ...('context' in value ? { context: value.context as boolean | undefined } : {}),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    maxToolRounds,
    maxToolCalls,
    parallelTools,
    ...(pricing === undefined ? {} : { pricing })
  }
}

export const AgentConfigSchema: StandardSchemaV1<AgentConfig, AgentConfig> = {
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
