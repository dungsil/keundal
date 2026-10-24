import type { AGUIEvent } from '@keundal/core'
import { defineComponent, onBeforeUnmount, onMounted, watch, type PropType } from 'vue'

import { applyLiveTraceEvent, type LiveTrace } from '../lib/live-trace'

/** Renderless: follows the run events of its conversation and writes them into the live trace. */
export default defineComponent({
  name: 'TraceObserver',
  props: {
    pendingRunId: { type: String, default: undefined },
    subscribe: { type: Function as PropType<(listener: (event: AGUIEvent) => void) => () => void>, required: true },
    trace: { type: Object as PropType<LiveTrace>, required: true },
    release: { type: Function as PropType<() => void>, required: true }
  },
  setup(props) {
    // A run that was still active when the conversation loaded is the one to follow until its first event arrives.
    watch(() => props.pendingRunId, (runId) => {
      if (runId) props.trace.activeRunId = runId
    }, { immediate: true })

    let unsubscribe: (() => void) | undefined
    onMounted(() => {
      unsubscribe = props.subscribe(event => applyLiveTraceEvent(props.trace, event))
    })
    onBeforeUnmount(() => {
      unsubscribe?.()
      props.release()
    })
    return () => null
  }
})
