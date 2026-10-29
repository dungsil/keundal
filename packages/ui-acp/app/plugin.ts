import type { ExecutionOptions } from '@keundal/core'
import type {} from '@keundal/ui/app/contracts/chat.ts'
import type {} from '@keundal/ui-runtime'
import type { Context } from 'cordis'
import { lazyView } from '@keundal/ui-slots'
import { defineComponent, onScopeDispose } from 'vue'
import { applyLiveExecutionEvent, createLiveExecution, type LiveExecution } from './lib/live-execution'

export const name = 'ui-acp'
export const inject = ['slots', 'chatRuntime']

const AcpExecution = lazyView(() => import('./views/AcpExecution.vue'), [
  'messages', 'status', 'live', 'getRun'
])
const AcpObserver = defineComponent({ setup: () => () => null })

/** Always registered, including when the external agent is no longer installed. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  const lives = new Map<string, LiveExecution>()
  function liveOf(chatId: string) {
    if (!lives.has(chatId)) lives.set(chatId, createLiveExecution())
    return lives.get(chatId)!
  }
  // Subscribe synchronously, before the lazy panel and the first journal replay.
  ctx.slots.inject('chat.observer', () => ctx.slots.register({
    name: 'chat.observer',
    id: 'acp',
    inject: ({ chatId, subscribe }) => {
      const live = liveOf(chatId)
      const unsubscribe = subscribe(event => applyLiveExecutionEvent(live, event))
      onScopeDispose(() => { unsubscribe(); lives.delete(chatId) })
      return {}
    }
  }, AcpObserver))
  ctx.slots.inject('chat.execution', () => ctx.slots.register({
    name: 'chat.execution',
    id: 'acp',
    inject: ({ chatId }) => ({ live: liveOf(chatId), getRun: (runId: string, options?: ExecutionOptions) => runtime.store.getRun(runId, options) })
  }, AcpExecution))
}
