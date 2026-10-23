import type { ChatSummary } from '@keundal/ui-runtime'
import { computed } from 'vue'

import { useText } from '../locale'
import { useChats } from './useChats'

/** Group the runtime's chat summaries by date, labelling untitled chats. */
export function useChatGroups(chats: () => readonly ChatSummary[] | undefined) {
  const { t } = useText()
  const localizedChats = computed(() => chats()?.map(chat => ({
    id: chat.id,
    label: chat.title || t('chat.untitled'),
    untitled: !chat.title,
    to: `/chat/${chat.id}`,
    icon: 'i-lucide-message-circle',
    createdAt: chat.createdAt
  })))
  return useChats(localizedChats)
}
