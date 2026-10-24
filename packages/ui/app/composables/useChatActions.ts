import { LazyModalConfirm, LazyModalRename } from '#components'

/** Conversation operations the caller's plugin injects. */
export interface ChatActionOperations {
  rename(id: string, title: string): Promise<void>
  remove(id: string): Promise<void>
}

/** Confirm, run and report renaming and deleting a conversation. */
export function useChatActions(operations: ChatActionOperations) {
  const { t } = useLocale()
  const route = useRoute()
  const toast = useToast()
  const overlay = useOverlay()

  const renameModal = overlay.create(LazyModalRename)
  const deleteModal = overlay.create(LazyModalConfirm)

  async function renameChat(id: string, currentTitle?: string | null): Promise<string | null> {
    const instance = renameModal.open({ title: currentTitle ?? '' })
    const result = await instance.result

    if (!result || result === currentTitle) return null

    try {
      await operations.rename(id, result)
      return result
    } catch {
      toast.add({
        description: t('chat.renameFailed'),
        icon: 'i-lucide-alert-circle',
        color: 'error',
        duration: 0
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
      await operations.remove(id)

      toast.add({
        title: t('chat.deleted'),
        description: t('chat.deletedDescription'),
        icon: 'i-lucide-trash'
      })

      if (route.params.id === id) {
        navigateTo('/')
      }

      return true
    } catch {
      toast.add({
        description: t('chat.deleteFailed'),
        icon: 'i-lucide-alert-circle',
        color: 'error',
        duration: 0
      })

      return false
    }
  }

  return {
    renameChat,
    deleteChat
  }
}
