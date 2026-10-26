import type {} from '@keundal/ui-chat/slots'
import type { Context } from 'cordis'
import type { Component } from 'vue'
import { lazyView } from '@keundal/ui-slots'

export const name = 'ui-tool'
export const inject = ['slots']

const toolView = (load: () => Promise<{ default: Component }>) => lazyView(load, ['part'])

const Chart = toolView(() => import('./views/Chart.vue'))
const Weather = toolView(() => import('./views/Weather.vue'))
const Markdown = toolView(() => import('./views/Markdown.vue'))
const Subagent = toolView(() => import('./views/Subagent.vue'))
const SkillTool = toolView(() => import('./views/SkillTool.vue'))
const SearchTool = toolView(() => import('./views/SearchTool.vue'))

/** Render tool calls with a dedicated view. */
export function apply(ctx: Context) {
  ctx.slots.inject('chat.message.tool', () => [
    ctx.slots.register({ name: 'chat.message.tool', key: 'chart' }, Chart),
    ctx.slots.register({ name: 'chat.message.tool', key: 'weather' }, Weather),
    ctx.slots.register({ name: 'chat.message.tool', key: 'markdown' }, Markdown),
    ctx.slots.register({ name: 'chat.message.tool', key: 'delegate_task' }, Subagent),
    ctx.slots.register({ name: 'chat.message.tool', key: 'skill' }, SkillTool),
    ctx.slots.register({ name: 'chat.message.tool', key: 'web_search' }, SearchTool),
    ctx.slots.register({ name: 'chat.message.tool', key: 'google_search' }, SearchTool)
  ])
}
