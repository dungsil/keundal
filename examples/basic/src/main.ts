import { EventType, parseAGUIEvent, type AgentMessage, type RunAgentInput } from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-simple'
import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { Context } from 'cordis'

const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_MODEL
if (!apiKey?.trim() || !model?.trim()) {
  console.error('OPENAI_API_KEY와 OPENAI_MODEL 환경 변수를 설정한 뒤 다시 실행하세요.')
  process.exit(1)
}
const contextWindow = Number(process.env.OPENAI_CONTEXT_WINDOW ?? 128_000)
const maxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 4_096)

const ctx = new Context()
await ctx.plugin(openaiLLMPlugin, {
  apiKey,
  models: { [model]: { contextWindow, maxOutputTokens } }
})
await ctx.plugin(sqliteStorePlugin, { path: 'keundal.sqlite' })
await ctx.plugin(agentPlugin, {
  model,
  maxOutputTokens: Math.min(1024, maxOutputTokens, contextWindow - 1),
  tools: [
    {
      name: 'clock',
      description: '현재 시각을 확인합니다.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => new Date().toLocaleString('ko-KR')
    }
  ]
})

// 클라이언트가 대화 이력을 유지하고, 저장소는 생성된 메시지를 영속화하며,
// session.prepare가 두 이력을 병합해 모델 입력을 만듭니다.
const threadId = 'conversation-1'
const history: AgentMessage[] = []

const turns = [
  ['run-1', '지금 몇 시인지 clock 도구로 확인해줘.'],
  ['run-2', '방금 확인한 시각을 한 문장으로 요약해줘.']
] as const

for (const [runId, content] of turns) {
  const userMessage: AgentMessage = { id: runId, role: 'user', content }
  const input: RunAgentInput = {
    threadId,
    runId,
    state: undefined,
    tools: [],
    context: [],
    messages: [...history, userMessage]
  }

  console.log(`\n>>> ${content}`)
  for await (const raw of ctx.agent.run(input)) {
    const event = parseAGUIEvent(raw)
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) process.stdout.write(event.delta)
    if (event.type === EventType.TOOL_CALL_START) console.log(`[도구 호출] ${event.toolCallName}`)
    if (event.type === EventType.RUN_FINISHED) console.log('')
  }

  // 실행이 커밋한 생성 메시지를 이력에 누적해 다음 턴의 입력으로 삼습니다.
  const snapshot = await ctx.session.get(threadId)
  history.push(userMessage, ...(snapshot?.messages ?? []))
}

// cordis 파이버가 프로세스 종료를 막지 않게 명시적으로 끝냅니다.
process.exit(0)
