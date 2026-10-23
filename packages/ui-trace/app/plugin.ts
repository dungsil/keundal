import type { ExecutionOptions } from '@keundal/core'
import type {} from '@keundal/ui-chat/slots'
import type {} from '@keundal/ui-runtime'
import type { Context } from 'cordis'

import { createLiveTrace, type LiveTrace } from './lib/live-trace'
import TraceFooter from './views/TraceFooter.vue'
import TraceIndicator from './views/TraceIndicator.vue'
import TraceObserver from './views/TraceObserver'

export const name = 'ui-trace'
export const inject = ['slots', 'chatRuntime']

/** Show the execution trace of a conversation: the live trace of the active run and a panel below each response. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  // One live trace per conversation page. The observer writes it, and the indicator and footer entries read it.
  const traces = new Map<string, LiveTrace>()
  const traceOf = (chatId: string) => {
    let trace = traces.get(chatId)
    if (!trace) traces.set(chatId, trace = createLiveTrace())
    return trace
  }
  const getRun = (runId: string, options?: ExecutionOptions) => runtime.store.getRun(runId, options)
  ctx.slots.inject('chat.observer', () => ctx.slots.register({
    name: 'chat.observer',
    id: 'trace',
    inject: ({ chatId }) => ({ trace: traceOf(chatId), release: () => traces.delete(chatId) })
  }, TraceObserver))
  ctx.slots.inject('chat.indicator', () => ctx.slots.register({
    name: 'chat.indicator',
    id: 'trace',
    order: 0,
    inject: ({ chatId }) => ({ trace: traceOf(chatId), getRun })
  }, TraceIndicator))
  ctx.slots.inject('chat.message.footer', () => ctx.slots.register({
    name: 'chat.message.footer',
    id: 'trace',
    order: 0,
    inject: ({ chatId }) => ({ trace: traceOf(chatId), getRun })
  }, TraceFooter))
}
