import { AgentConfigSchema, registerAgent, type AgentConfig } from '@keundal/agent-loop'
import type { Context } from 'cordis'

export const metadata = {
  name: { en: 'Chat agent', ko: '대화 에이전트' },
  description: {
    en: 'Generates responses and runs tools in conversations.',
    ko: '대화에서 응답을 생성하고 도구를 실행합니다.'
  }
}

export const chatAgentPlugin = Object.assign(
  function chatAgentPlugin(ctx: Context, config: AgentConfig) {
    registerAgent(ctx, config)
  },
  { inject: ['llm', 'generation', 'session'], Config: AgentConfigSchema }
)

export default chatAgentPlugin
