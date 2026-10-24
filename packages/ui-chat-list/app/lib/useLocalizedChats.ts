import type { ChatSummary } from '@keundal/ui-runtime'
import { chatPath } from '@keundal/ui/app/utils/chat-navigation.ts'
import { computed, type ComputedRef } from 'vue'

import { useText } from '../locale'
import type { UIChat } from './useChats'

/** Map the runtime's chat summaries to list items, labelling untitled chats. */
export function useLocalizedChats(chats: () => readonly ChatSummary[] | undefined): ComputedRef<UIChat[] | undefined> {
  const { t } = useText()
  return computed(() => chats()?.map(chat => ({
    id: chat.id,
    label: chat.title || t('chat.untitled'),
    untitled: !chat.title,
    to: chatPath(chat.id),
    icon: 'i-lucide-message-circle',
    createdAt: chat.createdAt
  })))
}
