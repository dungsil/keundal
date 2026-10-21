import { Agent, parseAgentConfig, registerAgent, type AgentConfig } from '@keundal/agent-loop'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Context } from 'cordis'

import { CODING_SYSTEM_PROMPT } from './prompt.js'

export type { ExecutableTool, ToolExecutionContext, ToolProvider } from '@keundal/tools'

/**
 * 코딩 에이전트 설정입니다. `systemPrompt`을 생략하면 기본 코딩 지침을 사용하고, 지정하면
 * 기본 지침을 대체합니다. 나머지 설정은 에이전트 구현 계약과 같습니다.
 */
export type CodingAgentConfig = AgentConfig

export const codingAgentConfigSchema: StandardSchemaV1<CodingAgentConfig, CodingAgentConfig> = {
  '~standard': {
    version: 1,
    vendor: 'keundal',
    validate(value) {
      try {
        return { value: parseAgentConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : 'invalid coding agent config' }] }
      }
    }
  }
}

/**
 * 에이전트 구현 계약을 확장한 코딩 에이전트입니다. 기본 코딩 지침을 모든 실행에 앞서
 * 모델에 전달합니다.
 */
export class CodingAgent extends Agent {
  protected override systemPrompt(): string {
    return this.config.systemPrompt ?? CODING_SYSTEM_PROMPT
  }
}

export const codingAgentPlugin = Object.assign(
  function codingAgentPlugin(ctx: Context, config: CodingAgentConfig) {
    registerAgent(ctx, config, CodingAgent)
  },
  { inject: ['llm', 'generation', 'session'], Config: codingAgentConfigSchema }
)

export { CODING_SYSTEM_PROMPT }
export default codingAgentPlugin
