import { LazyModalConfirm, LazyModalRename } from '#components'

interface ChatListItem {
  id: string
  label: string
  to: string
  icon?: string
  createdAt: string | Date
}

export function useChatActions() {
  const { t } = useLocale()
  const route = useRoute()
  const toast = useToast()
  const overlay = useOverlay()
  const { $chatStore } = useNuxtApp()

  const renameModal = overlay.create(LazyModalRename)
  const deleteModal = overlay.create(LazyModalConfirm)

  async function renameChat(id: string, currentTitle?: string | null): Promise<string | null> {
    const instance = renameModal.open({ title: currentTitle ?? '' })
    const result = await instance.result

    if (!result || result === currentTitle) return null

    try {
      await $chatStore.rename(id, result)

      const chatsCache = useNuxtData<ChatListItem[]>('chats')
      if (chatsCache.data.value) {
        chatsCache.data.value = chatsCache.data.value.map(c => (c.id === id ? { ...c, label: result } : c))
      }

      const chatCache = useNuxtData<{ title: string | null }>(`chat-${id}`)
      if (chatCache.data.value) {
        chatCache.data.value = { ...chatCache.data.value, title: result }
      }

      return result
    } catch {
      toast.add({
        description: t('chat.renameFailed'),
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })

      return null
    }
  }

  async function deleteChat(id: string): Promise<boolean> {
    const instance = deleteModal.open({
      title: t('chat.deleteTitle'),
      description: t('chat.deleteDescription'),
      color: 'error'
    })
    const result = await instance.result

    if (!result) return false

    try {
      await $chatStore.delete(id)

      toast.add({
        title: t('chat.deleted'),
        description: t('chat.deletedDescription'),
        icon: 'i-lucide-trash'
      })

      const chatsCache = useNuxtData<ChatListItem[]>('chats')
      if (chatsCache.data.value) {
        chatsCache.data.value = chatsCache.data.value.filter(c => c.id !== id)
      }

      if (route.params.id === id) {
        navigateTo('/')
      }

      return true
    } catch {
      toast.add({
        description: t('chat.deleteFailed'),
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })

      return false
    }
  }

  return {
    renameChat,
    deleteChat
  }
}
