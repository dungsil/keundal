import { ShellService, type ExecutionOptions, type ShellRequest } from '@keundal/core'
import shellToolsPlugin, { ShellToolsService } from '@keundal/plugin-tool-shell'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

test('shell 도구가 인자를 검증하고 요청과 취소 신호를 공급자에게 전달한다', async () => {
  const ctx = new Context()
  const calls: { request: ShellRequest; options?: ExecutionOptions }[] = []
  const result = {
    stdout: 'ok',
    stderr: '',
    exitCode: 4,
    signal: null,
    timedOut: false,
    aborted: false,
    truncated: false
  }
  class MockShell extends ShellService {
    async execute(request: ShellRequest, options?: ExecutionOptions) {
      calls.push({ request, options })
      return result
    }
  }
  const provider = await ctx.plugin((ctx) => {
    new MockShell(ctx)
  })
  const tools = await ctx.plugin(shellToolsPlugin)
  try {
    expect(ctx.shellTools).toBeInstanceOf(ShellToolsService)
    expect(ctx.shellTools.tools).toHaveLength(1)
    const tool = ctx.shellTools.tools[0]!
    expect(tool.name).toBe('shell')
    const context = { threadId: 'thread', runId: 'run', toolCallId: 'call', signal: new AbortController().signal }
    const args = { command: 'echo ok', cwd: 'sub', timeoutMs: 10 }
    expect(JSON.parse(await tool.execute(args, context))).toEqual(result)
    expect(calls).toEqual([{ request: args, options: { signal: context.signal } }])
    expect(calls[0]!.options!.signal).toBe(context.signal)
    for (const invalid of [
      {},
      { command: ' ' },
      { command: 'x', cwd: 1 },
      { command: 'x', timeoutMs: -1 },
      { command: 'x', timeoutMs: 1.5 },
      { command: 'x', extra: true }
    ]) {
      await expect(tool.execute(invalid, context)).rejects.toThrow('invalid shell arguments')
    }
    expect(calls).toHaveLength(1)
  } finally {
    await tools.dispose()
    await provider.dispose()
  }
})
