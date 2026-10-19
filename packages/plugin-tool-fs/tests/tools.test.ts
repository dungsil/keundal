import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventType, LLMService, type LLMEvent, type LLMRequest } from '@keundal/core'
import simpleAgentPlugin from '@keundal/plugin-agent-simple'
import localFileSystemPlugin from '@keundal/plugin-fs-local'
import fileSystemPolicyPlugin from '@keundal/plugin-fs-policy'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import fileSystemToolsPlugin from '@keundal/plugin-tool-fs'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'keundal-fs-tools-'))
  const ctx = new Context()
  const raw = ctx.isolate('fs')
  const provider = await raw.plugin(localFileSystemPlugin, { cwd: root })
  const policy = await ctx.plugin(fileSystemPolicyPlugin, { backend: raw.fs, roots: [root], writableRoots: [root] })
  const tools = await ctx.plugin(fileSystemToolsPlugin)
  t.onTestFinished(async () => {
    await tools.dispose()
    await policy.dispose()
    await provider.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const context = { threadId: 'thread', runId: 'run', toolCallId: 'call', signal: new AbortController().signal }
  const execute = (name: string, args: Record<string, unknown>, threadId = context.threadId) =>
    ctx.fsTools.tools.find((tool) => tool.name === name)!.execute(args, { ...context, threadId })
  return { ctx, root, execute, context, policy, raw }
}

test('파일 도구가 인자를 검증하고 threadId별 읽기 기록과 취소를 적용한다', async (t) => {
  const { ctx, root, execute, context } = await setup(t)
  await writeFile(join(root, 'file'), 'hello world')
  await expect(execute('write_file', { path: 'file', content: 'blind' })).rejects.toThrow('version conflict')
  expect(JSON.parse(await execute('read_file', { path: 'file' }))).toMatchObject({ content: 'hello world' })
  await expect(execute('edit_file', { path: 'file', oldText: 'hello', newText: 'hi' }, 'other')).rejects.toThrow()
  await execute('edit_file', { path: 'file', oldText: 'hello', newText: 'hi' })
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('hi world')
  await execute('write_file', { path: 'new', content: '' })
  expect(JSON.parse(await execute('list_directory', { path: '.' }))).toEqual(
    expect.arrayContaining([{ name: 'new', kind: 'file' }])
  )
  for (const args of [{}, { path: 1 }, { path: '' }, { path: 'file', extra: true }]) {
    await expect(execute('read_file', args)).rejects.toThrow('invalid file tool arguments')
  }
  await expect(execute('write_file', { path: 'bad', content: 1 })).rejects.toThrow('invalid file tool arguments')
  await expect(execute('edit_file', { path: 'file', oldText: 'hi' })).rejects.toThrow('invalid file tool arguments')
  await expect(
    ctx.fsTools.tools[0]!.execute({ path: 'file' }, { ...context, signal: AbortSignal.abort(new Error('cancelled')) })
  ).rejects.toThrow('cancelled')
})

test('파일 서비스를 교체하면 도구 플러그인을 새 서비스로 다시 구성한다', async (t) => {
  const { ctx, root, policy, raw, execute } = await setup(t)
  await writeFile(join(root, 'file'), 'original')
  const previous = ctx.fsTools
  await execute('read_file', { path: 'file' })
  await policy.dispose()
  expect(ctx.fsTools).toBeUndefined()
  const replacement = await ctx.plugin(fileSystemPolicyPlugin, {
    backend: raw.fs,
    roots: [root],
    writableRoots: []
  })
  t.onTestFinished(() => replacement.dispose())
  expect(ctx.fsTools).not.toBe(previous)
  expect(JSON.parse(await execute('read_file', { path: 'file' }))).toMatchObject({ content: 'original' })
  await expect(execute('write_file', { path: 'file', content: 'changed' })).rejects.toThrow('read-only')
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('original')
})

test('에이전트가 실제 파일을 읽고 수정한 도구 결과를 후속 생성과 세션에 보존한다', async (t) => {
  const { ctx, root } = await setup(t)
  await writeFile(join(root, 'file'), 'hello world')
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 4000, maxOutputTokens: 500 }
    }
    async countTokens() {
      return 100
    }
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
      const results = request.input.messages.filter((message) => message.role === 'tool')
      const round = results.length
      if (round < 2) {
        if (round === 1) expect(JSON.parse(results[0]!.content as string)).toMatchObject({ content: 'hello world' })
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: `call-${round}`,
          toolCallName: round ? 'edit_file' : 'read_file'
        }
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: `call-${round}`,
          delta: JSON.stringify(round ? { path: 'file', oldText: 'world', newText: 'Keundal' } : { path: 'file' })
        }
        yield { type: EventType.TOOL_CALL_END, toolCallId: `call-${round}` }
      } else {
        expect(JSON.parse(results[1]!.content as string)).toMatchObject({
          path: join(root, 'file'),
          version: expect.any(String)
        })
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'updated' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
      }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const agent = await ctx.plugin(simpleAgentPlugin, { model: 'test', maxOutputTokens: 200, tools: ctx.fsTools.tools })
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })
  const events = []
  for await (const event of ctx.agent.run({
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    tools: [],
    messages: [{ id: 'question', role: 'user', content: 'update the file' }]
  }))
    events.push(event)
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(events.filter((event) => event.type === EventType.TOOL_CALL_RESULT)).toHaveLength(2)
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('hello Keundal')
  const messages = (await ctx.session.get('thread'))!.messages
  expect(messages.filter((message) => message.role === 'tool')).toHaveLength(2)
  expect(messages).toContainEqual({ id: 'answer', role: 'assistant', content: 'updated' })
})
