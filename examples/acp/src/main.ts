import { realpath, stat } from 'node:fs/promises'

import { createAcpAgent, createAcpStdioStream } from '@keundal/acp'
import codingAgentPlugin from '@keundal/plugin-agent-coding'
import { LocalFileSystemService } from '@keundal/plugin-fs-local'
import { PolicyFileSystemService } from '@keundal/plugin-fs-policy'
import openaiPlugin from '@keundal/plugin-llm-openai'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import fileSystemToolsPlugin from '@keundal/plugin-tool-fs'
import { Context } from 'cordis'

const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_MODEL
if (!apiKey?.trim() || !model?.trim()) {
  console.error('OPENAI_API_KEY와 OPENAI_MODEL 환경 변수를 설정하세요.')
  process.exit(1)
}
const contextWindow = Number(process.env.OPENAI_CONTEXT_WINDOW ?? 128_000)
const maxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 4096)

const adapter = createAcpAgent({
  async createSession({ cwd, toolApproval }) {
    const root = await realpath(cwd)
    if (!(await stat(root)).isDirectory()) throw new Error('cwd must be a directory')
    const ctx = new Context()
    const scope = ctx.plugin(async (child: Context) => {
      await child.plugin(openaiPlugin, {
        apiKey,
        models: { [model]: { contextWindow, maxOutputTokens } }
      })
      await child.plugin(memoryStorePlugin)
      let backend!: LocalFileSystemService
      await child.isolate('fs').plugin((files: Context) => {
        backend = new LocalFileSystemService(files, { cwd: root })
      })
      await child.plugin((files: Context) => {
        new PolicyFileSystemService(files, { backend, roots: [root], writableRoots: [root] })
      })
      await child.plugin(fileSystemToolsPlugin)
      await child.plugin({
        inject: ['fsTools'],
        async apply(agent: Context) {
          await agent.plugin(codingAgentPlugin, {
            model,
            maxOutputTokens,
            tools: agent.fsTools.tools,
            toolApproval,
            skills: false,
            subagents: false,
            promptPresets: false
          })
        }
      })
    })
    try {
      await scope
      return {
        async *run(input, options) {
          const snapshot = await ctx.session.get(input.threadId, options)
          await ctx.session.commit(
            {
              threadId: input.threadId,
              expectedRevision: snapshot?.revision ?? 0,
              messages: input.messages,
              state: input.state
            },
            options
          )
          yield* ctx.agent.run(input, options)
        },
        dispose: () => scope.dispose()
      }
    } catch (error) {
      await scope.dispose()
      throw error
    }
  }
})

const stop = () => {
  void adapter.dispose().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
const connection = adapter.app.connect(createAcpStdioStream())
try {
  await connection.closed
} finally {
  await adapter.dispose()
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
