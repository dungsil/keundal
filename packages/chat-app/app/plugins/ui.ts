import type { Reasoning } from '@keundal/llm'
import type { ChatPlatform } from '@keundal/chat/platform'
import { ChatRuntime, SettingsLoadError } from '@keundal/ui-runtime'
import { SlotService } from '@keundal/ui-slots'
import { Context } from 'cordis'

import { UIPluginManager } from '../ui-plugins'

declare module '#app' {
  interface NuxtApp {
    $chatPlatform?: ChatPlatform
    $ui: Context
  }
}

/**
 * Assemble the interface: the slot registry, the chat runtime and every UI plugin, for each application instance on
 * the server and in the browser. Plugins register the same entries on both sides, so hydration matches.
 */
export default defineNuxtPlugin({
  name: 'keundal-ui',
  async setup(nuxtApp) {
    const { t } = useLocale()
    const toast = useToast()
    const router = useRouter()
    const ctx = new Context()
    const fibers = [ctx.plugin(SlotService)]
    await fibers[0]
    const runtime = ctx.plugin(ChatRuntime, {
      platform: import.meta.client ? nuxtApp.$chatPlatform : undefined,
      capabilities: useRuntimeConfig().public.chatCapabilities,
      storage: import.meta.client ? localStorage : undefined,
      preferences: {
        webSearch: useCookie<boolean | null | undefined>('web-search'),
        reasoning: useCookie<Reasoning | null | undefined>('reasoning')
      },
      openProviderSettings: provider => void router.push({
        path: '/settings/llm',
        query: { provider, returnTo: router.currentRoute.value.path }
      }),
      notifyError: description => toast.add({ description, icon: 'i-lucide-alert-circle', color: 'error', duration: 0 }),
      messages: { modelsLoadFailed: () => t('model.loadFailed'), modelSwitchFailed: () => t('model.switchFailed') }
    })
    fibers.push(runtime)
    await runtime
    if (import.meta.client) {
      if (!nuxtApp.$chatPlatform) throw new Error('The application must provide a chat-platform plugin')
      try {
        await ctx.chatRuntime.start()
      } catch (error) {
        if (error instanceof SettingsLoadError && useRuntimeConfig().public.chatCapabilities.secureSettings) {
          throw createError({ statusCode: 503, statusMessage: t('error.secureStorage'), message: t('error.secureStorageDescription'), cause: error.cause })
        }
        throw error instanceof SettingsLoadError ? error.cause : error
      }
    }
    const pluginManager = new UIPluginManager(ctx, {
      stop: () => ctx.chatRuntime.stopResponses(),
      platform: import.meta.client ? nuxtApp.$chatPlatform?.runtimePlugins : undefined
    })
    ctx.chatRuntime.pluginManager = nuxtApp.$chatPlatform?.runtimePlugins ? pluginManager : undefined
    if (import.meta.client) nuxtApp.hook('app:mounted', () => pluginManager.sync())

    let disposal: Promise<void> | undefined
    const dispose = () => disposal ??= (async () => {
      try {
        await pluginManager.close()
      } finally {
        for (const fiber of fibers.toReversed()) await fiber.dispose()
      }
    })()
    nuxtApp.vueApp.onUnmount(() => void dispose())
    if (import.meta.hot) import.meta.hot.dispose(dispose)
    try {
      await pluginManager.mount()
    } catch (error) {
      await dispose()
      throw error
    }
    return { provide: { ui: ctx } }
  }
})
