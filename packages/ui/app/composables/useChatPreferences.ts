/** Conversation UI preferences shared by settings and conversation actions. */
export function useChatPreferences() {
  const saved = useCookie<boolean>('keundal-skip-delete-confirmation', {
    default: () => false,
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    path: '/'
  })
  const skipDeleteConfirmation = useState('keundal-skip-delete-confirmation', () => saved.value === true)

  function setSkipDeleteConfirmation(value: boolean) {
    skipDeleteConfirmation.value = value
    saved.value = value
  }

  return { skipDeleteConfirmation: readonly(skipDeleteConfirmation), setSkipDeleteConfirmation }
}
