import { appendContext } from '@keundal/context'
import type { RunAgentInput } from '@keundal/core'
import contextPlugin from '@keundal/plugin-context'
import { Context } from 'cordis'
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

test('공급자를 순서대로 실행하고 예약된 사용자 메시지만 추가한다', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(contextPlugin, {
    providers: [
      (current) => appendContext(current, 'first', 'one'),
      (current) => appendContext(current, 'second', String(current.messages.length))
    ]
  })
  const result = await ctx.requestContext.prepare(input, { step: 1, request: input })
  expect(result.messages.map((message) => message.content)).toEqual(['one', '1'])
  expect(input.messages).toEqual([])
  await fiber.dispose()
})

test('예약 접두사가 없는 추가 메시지를 거부하고 취소를 전달한다', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(contextPlugin, {
    providers: [
      (current) => ({
        ...current,
        messages: [{ id: 'unreserved', role: 'user', content: 'invalid' }]
      })
    ]
  })
  await expect(ctx.requestContext.prepare(input, { step: 1, request: input })).rejects.toThrow('reserved user text')
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await expect(
    ctx.requestContext.prepare(input, { step: 1, request: input, signal: controller.signal })
  ).rejects.toThrow('cancelled')
  await fiber.dispose()
})
