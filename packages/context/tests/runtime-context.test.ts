import { createHarnessDevContext, createTimeContext, createTmuxContext } from '@keundal/context'
import type { ContextOptions } from '@keundal/context'
import type { RunAgentInput } from '@keundal/core'
import { describe, expect, test } from 'vitest'

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

describe('요청 런타임 컨텍스트', () => {
  test('시간대별 시각을 기록하고 이력 기준으로 갱신을 예약한다', () => {
    let clock = Date.parse('2025-01-01T00:00:00Z')
    const provider = createTimeContext({ timeZone: 'Asia/Tokyo', refreshIntervalMs: 600_000, now: () => clock })
    const request = { ...input, forwardedProps: { browserTimeZone: 'America/New_York' } }
    const first = provider(request, options(1, undefined, request)) as RunAgentInput
    const content = first.messages.at(-1)?.content as string
    expect(content).toContain('America/New_York')
    expect(content).toContain('-05:00[America/New_York]')
    clock += 599_999
    expect(provider(first, options(2, undefined, request))).toBe(first)
    clock += 1
    const second = provider(first, options(2, undefined, request)) as RunAgentInput
    expect(second.messages.at(-1)?.content).toMatch(/600s\./)
  })
  test('혼합·누락 시간대를 안내하고 역행한 시계의 경과 시간을 0으로 제한한다', () => {
    let clock = 10_000
    const provider = createTimeContext({ timeZone: 'Asia/Seoul', now: () => clock, refreshIntervalMs: 0 })
    const mixed = { ...input, forwardedProps: { browserTimeZones: ['Asia/Seoul', 'Europe/Paris'] } }
    const first = provider(mixed, options(1, undefined, mixed)) as RunAgentInput
    expect(first.messages.at(-1)?.content).toContain('mixed; ask the user')
    clock = 9_000
    const next = provider(first, options(2, undefined, mixed)) as RunAgentInput
    expect(next.messages.at(-1)?.content).toMatch(/0s\./)
    const absent = provider(input, options()) as RunAgentInput
    expect(absent.messages.at(-1)?.content).toContain('unavailable; ask the user')
    expect(() => createTimeContext({ timeZone: 'not/a-zone' })).toThrow(/invalid IANA timeZone/)
  })

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

  test('Keundal 경로·GUI 안내는 안정적으로 유지하고 런타임 값 변경을 보존한다', () => {
    const provider = createHarnessDevContext({ checkoutPath: 'C:/checkout', webGuiUrl: 'http://localhost:3000' })
    const first = provider(input, options()) as RunAgentInput
    expect(first.messages.some((message) => message.content?.includes('C:/checkout'))).toBe(true)
    expect(first.messages.some((message) => message.content?.includes('http://localhost:3000'))).toBe(true)
    expect(provider(first, options())).toBe(first)
    const changed = createHarnessDevContext({ checkoutPath: 'D:/checkout', webGuiUrl: 'http://localhost:3001' })(
      first,
      options()
    ) as RunAgentInput
    expect(changed.messages.slice(0, 3)).toEqual(first.messages)
    expect(changed.messages.slice(3).some((message) => message.content?.includes('D:/checkout'))).toBe(true)
    expect(changed.messages.slice(3).some((message) => message.content?.includes('http://localhost:3001'))).toBe(true)
    expect(changed.threadId).toBe(input.threadId)
    expect(changed.runId).toBe(input.runId)
  })
})
