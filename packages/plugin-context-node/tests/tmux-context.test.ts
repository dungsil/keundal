import type { ContextOptions } from '@keundal/context'
import type { RunAgentInput } from '@keundal/core'
import { createTmuxContext } from '@keundal/plugin-context-node'
import { expect, test } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: {},
  context: [],
  messages: [],
  tools: [],
  forwardedProps: {}
}
function options(step = 1, signal?: AbortSignal, request = input): ContextOptions {
  return { step, signal, request }
}

test('tmux가 없으면 추가하지 않고 실제 pane 위치의 변경만 기록하며 취소를 전파한다', async () => {
  let calls = 0
  const runner = async (_command: string, args: readonly string[]) => {
    calls += 1
    if (args[0] === '-o') return 'pts/2'
    if (args.at(-1) === '#{pane_tty}') return '/dev/pts/2'
    return ['dev', '0', 'shell', '1', '%2', '1', '1', 'layout'].join('\\t')
  }
  const absent = createTmuxContext({ env: {}, runner })
  expect(await absent(input, options())).toBe(input)
  expect(calls).toBe(0)

  const active = createTmuxContext({ env: { TMUX: 'socket', TMUX_PANE: '%2' }, runner })
  const controller = new AbortController()
  controller.abort()
  await expect(active(input, options(1, controller.signal))).rejects.toThrow()
  expect(calls).toBe(0)

  const first = (await active(input, options())) as RunAgentInput
  expect(first.messages.at(-1)?.content).toContain('session dev')
  expect(await active(first, options())).toBe(first)
})
