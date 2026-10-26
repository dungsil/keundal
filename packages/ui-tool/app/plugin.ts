import type {} from '@keundal/ui-chat/slots'
import type { Context } from 'cordis'
import type { Component } from 'vue'
import { lazyView } from '@keundal/ui-slots'

export const name = 'ui-tool'
export const inject = ['slots']

const toolView = (load: () => Promise<{ default: Component }>) => lazyView(load, ['part'])

const Subagent = toolView(() => import('./views/Subagent.vue'))
const SkillTool = toolView(() => import('./views/SkillTool.vue'))
const SearchTool = toolView(() => import('./views/SearchTool.vue'))

/** Render subagent, skill and web search tool cards. */
export function apply(ctx: Context) {
  ctx.slots.inject('chat.message.tool', () => [
    ctx.slots.register({ name: 'chat.message.tool', key: 'delegate_task' }, Subagent),
    ctx.slots.register({ name: 'chat.message.tool', key: 'skill' }, SkillTool),
    ctx.slots.register({ name: 'chat.message.tool', key: 'web_search' }, SearchTool),
    ctx.slots.register({ name: 'chat.message.tool', key: 'google_search' }, SearchTool)
  ])
}
