import { useRequestURL } from '#imports'

export default defineNuxtPlugin({
  name: 'runtime-plugin-preload',
  setup() {
    const configURL = useRuntimeConfig().public.pluginConfig
    if (typeof configURL !== 'string' || !configURL) return

    let url: URL
    try {
      url = new URL(configURL, useRequestURL().href)
    } catch {
      return
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return

    useHead({
      link: [{ key: 'runtime-plugin-config', rel: 'preload', as: 'fetch', href: url.href, crossorigin: 'anonymous' }]
    })
  }
})
