import type { Context } from 'cordis'
import type { MemoryDraft } from '@keundal/memory'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui/app/contracts/settings.ts'
import { lazyView } from '@keundal/ui-slots'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'

import { messages } from './locale'

const MemorySettings = lazyView(() => import('./views/MemorySettings.vue'), [
  'listMemories', 'saveMemory', 'deleteMemory', 'searchMemories',
  'memoryProject', 'saveMemoryProject', 'chats'
])

export const name = 'ui-memory'
export const inject = ['slots', 'chatRuntime']

export const metadata = {
  name: { en: 'Memory settings', ko: '메모리 설정' },
  description: {
    en: 'Manages and searches persistent memories and selects the memory project.',
    ko: '영구 메모리를 관리·검색하고 메모리 프로젝트를 선택합니다.'
  }
}

/** Add persistent memory management to settings. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'memory',
    order: 32,
    meta: { label: localizedText(messages, 'memory.title'), icon: 'i-lucide-brain', group: 'general' },
    inject: () => ({
      listMemories: () => runtime.listMemories(),
      saveMemory: (draft: MemoryDraft, id?: string, revision?: number) => runtime.saveMemory(draft, id, revision),
      deleteMemory: (id: string, revision: number) => runtime.deleteMemory(id, revision),
      searchMemories: (text: string, projectId?: string, threadId?: string, semantic?: boolean) => runtime.searchMemories(text, projectId, threadId, semantic),
      memoryProject: runtime.memoryProject,
      saveMemoryProject: (id: string) => runtime.saveMemoryProject(id),
      chats: runtime.chats
    })
  }, MemorySettings))
}
