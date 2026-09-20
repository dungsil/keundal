import { createServer } from 'node:http'

import type { RunAgentInput } from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-simple'
import anthropicLLMPlugin from '@keundal/plugin-llm-anthropic'
import geminiLLMPlugin from '@keundal/plugin-llm-gemini'
import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { Context } from 'cordis'

import { createAgentApp } from './app.js'

const port = Number(process.env.PORT ?? 8000)
const sqlitePath = process.env.KEUNDAL_SQLITE_PATH ?? 'keundal-server.sqlite'
const model = process.env.KEUNDAL_MODEL
const contextWindow = Number(process.env.KEUNDAL_CONTEXT_WINDOW ?? 128_000)
const maxOutputTokens = Number(process.env.KEUNDAL_MAX_OUTPUT_TOKENS ?? 4_096)
if (!model?.trim()) {
  console.error('KEUNDAL_MODEL 환경 변수를 설정하세요. 예: gpt-4.1-mini, gemini-2.5-flash, claude-sonnet-4-5')
  process.exit(1)
}

const ctx = new Context()
if (process.env.OPENAI_API_KEY) {
  await ctx.plugin(openaiLLMPlugin, {
    apiKey: process.env.OPENAI_API_KEY,
    models: { [model]: { contextWindow, maxOutputTokens } }
  })
} else if (process.env.GEMINI_API_KEY) {
  await ctx.plugin(geminiLLMPlugin, {
    apiKey: process.env.GEMINI_API_KEY,
    models: { [model]: { contextWindow, maxOutputTokens } }
  })
} else if (process.env.ANTHROPIC_API_KEY) {
  await ctx.plugin(anthropicLLMPlugin, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    models: { [model]: { contextWindow, maxOutputTokens } }
  })
} else {
  console.error('OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY 중 하나를 설정하세요.')
  process.exit(1)
}
await ctx.plugin(sqliteStorePlugin, { path: sqlitePath })
await ctx.plugin(agentPlugin, {
  model,
  maxOutputTokens: Math.min(1024, maxOutputTokens, contextWindow - 1)
})

// GET 라우트가 JSON 직렬화할 수 없는 메서드는 서버가 노출하는 읽기 경로에서 제외합니다.
const app = createAgentApp({
  agent: (input: RunAgentInput, options) => ctx.agent.run(input, options),
  session: {
    get: (threadId, options) => ctx.session.get(threadId, options),
    list: (options) => ctx.session.list(options)
  },
  generation: {
    get: (runId, options) => ctx.generation.get(runId, options),
    list: (options) => ctx.generation.list(options),
    recover: (options) => ctx.generation.recover(options)
  }
})

createServer(app).listen(port, () => {
  console.log(`keundal server listening on http://localhost:${port}`)
  console.log(`POST /runs · GET /threads · GET /threads/:id · GET /runs · GET /runs/:id · POST /recover`)
})
