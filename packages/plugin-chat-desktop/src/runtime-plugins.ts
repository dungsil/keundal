import type { NativeInvoke, RuntimePluginInfo, RuntimePluginManager } from '@keundal/chat/platform'

/** Apply and restart as one frontend operation; native startup keeps the old process on failure. */
export function createNativeRuntimePluginManager(
  invoke: NativeInvoke,
  reload: () => Promise<void>
): RuntimePluginManager {
  let pending: Promise<unknown> = Promise.resolve()
  const mutate = (request: Record<string, unknown>): Promise<void> => {
    const operation = pending.then(async () => {
      const transaction = await invoke<{ previous: unknown[]; expected: unknown[] }>('runtime_plugins', { request })
      let restarted = false
      try {
        await reload()
        restarted = true
        const module = request.enabled === true ? request.module : undefined
        if (module) {
          const entries = await invoke<RuntimePluginInfo[]>('runtime_plugins', { request: { action: 'list' } })
          const error = entries.find((entry) => entry.module === module)?.error
          if (error) throw new Error(error)
        }
      } catch (error) {
        try {
          await invoke('runtime_plugins', { request: { action: 'restore', ...transaction } })
          if (restarted) await reload()
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Plugin reload and selection rollback failed')
        }
        throw error
      }
      // Delete managed files only after a successful restart; rollback still needs them before then.
      if (request.action === 'remove')
        await invoke('runtime_plugins', { request: { action: 'finalize', ...transaction } })
    })
    pending = operation.catch(() => {})
    return operation
  }
  return {
    async list() {
      await pending
      return invoke<RuntimePluginInfo[]>('runtime_plugins', { request: { action: 'list' } })
    },
    setEnabled: (module, enabled) => mutate({ action: 'enable', module, enabled }),
    install: (source) => mutate({ action: 'install', source }),
    remove: (module) => mutate({ action: 'remove', module })
  }
}
