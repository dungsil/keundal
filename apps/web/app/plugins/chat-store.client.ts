import { Context } from 'cordis'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import { ChatStore } from '../../shared/utils/chat-store'
import { remoteLLMPlugin } from '../../shared/utils/remote-llm'

export default defineNuxtPlugin(async () => {
  const ctx = new Context()
  const { csrf, headerName } = useCsrf()
  const llm = ctx.plugin(remoteLLMPlugin, {
    fetch: (url, init) => globalThis.fetch(url, { ...init, headers: { ...init?.headers, [headerName]: csrf } })
  })
  await llm
  const store = ctx.plugin(indexedDBStorePlugin, { databaseName: 'keundal-web' })
  await store
  const chatStore = new ChatStore(ctx)
  await chatStore.recover()
  if (import.meta.hot) import.meta.hot.dispose(async () => {
    await chatStore.stop()
    await store.dispose()
    await llm.dispose()
  })
  return { provide: { chatStore } }
})
