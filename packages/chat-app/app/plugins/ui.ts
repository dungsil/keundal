import type { Reasoning } from '@keundal/core'
import type { ChatPlatform } from '@keundal/chat/platform'
import { ChatRuntime, SettingsLoadError } from '@keundal/ui-runtime'
import { SlotService } from '@keundal/ui-slots'
import { Context } from 'cordis'

import { UIPluginManager, uiPluginCookie, type UIPluginSelections } from '../ui-plugins'

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
    const maxAge = 60 * 60 * 24 * 365
    const selections = useCookie<UIPluginSelections | null | undefined>(uiPluginCookie, {
      sameSite: 'lax', maxAge, watch: false
    })
    const pluginManager = new UIPluginManager(ctx, {
      selections: computed({
        get: () => selections.value,
        set: value => {
          if (import.meta.client) {
            // useCookie's watcher saves asynchronously. Write and verify here so denied cookie writes reject the
            // transaction instead of leaving live fibers different from the next SSR render.
            const encoded = value == null ? undefined : encodeURIComponent(JSON.stringify(value))
            document.cookie = `${uiPluginCookie}=${encoded ?? ''}; Path=/; SameSite=Lax; Max-Age=${encoded === undefined ? 0 : maxAge}`
            const saved = document.cookie.split('; ').find(cookie => cookie.startsWith(`${uiPluginCookie}=`))?.slice(uiPluginCookie.length + 1)
            if (saved !== encoded) throw new Error('Could not save UI plugin selections')
          }
          selections.value = value
        }
      }),
      stop: () => ctx.chatRuntime.stopResponses(),
      platform: import.meta.client ? nuxtApp.$chatPlatform?.runtimePlugins : undefined
    })
    ctx.chatRuntime.pluginManager = pluginManager

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
