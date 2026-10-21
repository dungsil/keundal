export function useStartupPending(key: string, status: Ref<string>) {
  const pending = useState<Record<string, boolean>>('startup-pending', () => ({}))
  watch(status, (value) => {
    pending.value[key] = value === 'pending' || value === 'idle'
  }, { immediate: true, flush: 'sync' })
  onUnmounted(() => {
    pending.value[key] = false
  })
}
