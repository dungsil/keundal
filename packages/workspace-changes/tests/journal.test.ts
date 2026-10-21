import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import agentPlugin from '@keundal/agent'
import { EventType, LLMService, type LLMEvent, type LLMRequest } from '@keundal/core'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { recordWorkspaceChanges } from '@keundal/workspace-changes'
import { WORKSPACE_CHANGES_EVENT } from '@keundal/workspace-changes/shared'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

test('Diff가 SQLite journal에 남고 재시작 후 복구되며 모델 입력에는 들어가지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'keundal-diff-journal-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', directory])
  await writeFile(join(directory, '.gitignore'), '*.sqlite*\n')
  await writeFile(join(directory, 'file'), 'before\n')
  const database = join(directory, 'store.sqlite')
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 8000, maxOutputTokens: 1000 }
    }
    async countTokens() {
      return 10
    }
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
      requests.push(request)
      if (requests.length === 1) {
        yield { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'write' }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '{}' }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'call' }
      } else {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'done' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
      }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(sqliteStorePlugin, { path: database })
  const agent = await ctx.plugin(agentPlugin, {
    model: 'test',
    maxOutputTokens: 100,
    wrapRunStream: recordWorkspaceChanges({ cwd: directory }),
    tools: [
      {
        name: 'write',
        description: 'write',
        parameters: {},
        execute: async () => {
          await writeFile(join(directory, 'file'), 'after\n')
          return '{}'
        }
      }
    ]
  })
  const events = []
  try {
    for await (const event of ctx.agent.run({
      threadId: 't',
      runId: 'r',
      state: {},
      context: [],
      tools: [],
      messages: []
    }))
      events.push(event)
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    expect(JSON.stringify(requests)).not.toContain('before')
    expect(JSON.stringify(requests)).not.toContain(WORKSPACE_CHANGES_EVENT)
  } finally {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  }
  const reopened = new Context()
  const reopenedLLM = await reopened.plugin(LLM)
  const persisted = await reopened.plugin(sqliteStorePlugin, { path: database })
  try {
    const run = await reopened.generation.get('r')
    const records = run?.journal.filter((entry) => entry.event.type === EventType.CUSTOM)
    expect(records?.at(-1)?.event).toMatchObject({
      name: WORKSPACE_CHANGES_EVENT,
      value: {
        status: 'complete',
        files: [{ path: 'file', before: 'before\n', after: 'after\n', additions: 1, deletions: 1 }]
      }
    })
  } finally {
    await persisted.dispose()
    await reopenedLLM.dispose()
  }
})
