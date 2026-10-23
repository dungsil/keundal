import type { ToolPart } from '@keundal/chat/chat-message'
import type {} from '@keundal/ui-chat/slots'
import type { Context } from 'cordis'
import { defineAsyncComponent, defineComponent, h, type Component, type PropType } from 'vue'

import SearchTool from './views/SearchTool.vue'
import SkillTool from './views/SkillTool.vue'
import Subagent from './views/Subagent.vue'

export const name = 'ui-tool'
export const inject = ['slots']

/**
 * Load a view on first use. The slot renderer reads props from the registered component, so the async wrapper is
 * hidden behind a component that declares them.
 */
function lazyView(load: () => Promise<Component>): Component {
  const View = defineAsyncComponent(load)
  return defineComponent({
    name: 'LazyToolView',
    props: { part: { type: Object as PropType<ToolPart>, required: true } },
    setup: props => () => h(View, { part: props.part })
  })
}

/** Render the tool calls that have their own card: chart, weather, subagent, skill and web search. */
export function apply(ctx: Context) {
  ctx.slots.inject('chat.message.tool', () => [
    ctx.slots.register({ name: 'chat.message.tool', key: 'chart' }, lazyView(() => import('./views/Chart.vue'))),
    ctx.slots.register({ name: 'chat.message.tool', key: 'weather' }, lazyView(() => import('./views/Weather.vue'))),
    ctx.slots.register({ name: 'chat.message.tool', key: 'delegate_task' }, Subagent),
    ctx.slots.register({ name: 'chat.message.tool', key: 'skill' }, SkillTool),
    ctx.slots.register({ name: 'chat.message.tool', key: 'web_search' }, SearchTool),
    ctx.slots.register({ name: 'chat.message.tool', key: 'google_search' }, SearchTool)
  ])
}
