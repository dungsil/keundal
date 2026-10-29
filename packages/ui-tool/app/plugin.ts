import type {} from '@keundal/ui/app/contracts/chat.ts'
import type { Context } from 'cordis'
import type { Component } from 'vue'
import { lazyView } from '@keundal/ui-slots'

export const name = 'ui-tool'
export const inject = ['slots']

export const metadata = {
  name: { en: 'Tool result cards', ko: '도구 결과 카드' },
  description: {
    en: 'Displays subagent, skill, and web search tool results.',
    ko: '서브에이전트·스킬·웹 검색 도구의 결과를 표시합니다.'
  }
}

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
