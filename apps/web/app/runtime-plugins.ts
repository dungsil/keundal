import {
  loadRuntimePlugins,
  parseRuntimePluginManifest,
  type RuntimeModuleRegistry,
  type RuntimePluginManifest
} from '@keundal/plugin-runtime'
import type { ToolProvider } from '@keundal/tools'

import defaultManifest from '../public/keundal.plugins.json'

export async function loadWebRuntimePlugins(
  configURL: string | undefined,
  builtins: RuntimeModuleRegistry,
  tools: ToolProvider | undefined,
  deferredToolProvider?: ToolProvider
) {
  let manifest: RuntimePluginManifest = defaultManifest
  let baseURL: URL | undefined
  if (configURL) {
    const url = new URL(configURL, globalThis.location?.href)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Plugin configuration requires an HTTP(S) URL')
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load plugin configuration: ${response.status} ${url}`)
    manifest = parseRuntimePluginManifest(await response.json())
    baseURL = new URL(response.url)
  }
  // The bundled skill service has its own lifetime so the settings switch can dispose it.
  const skills = manifest.plugins.find(spec => spec.module === 'builtin:skills')
  const composition = await loadRuntimePlugins({
    ...manifest,
    plugins: manifest.plugins.filter(spec => spec.module !== 'builtin:skills')
  }, {
    builtins,
    tools,
    deferredToolProvider,
    async importModule(specifier) {
      if (!baseURL) throw new Error('External plugins require a plugin configuration URL')
      if (!/^(?:https?:\/\/|\.{0,2}\/)/.test(specifier)) {
        throw new Error(`Browser plugins require an ESM URL, not a package name: ${specifier}`)
      }
      const url = new URL(specifier, baseURL)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported browser plugin URL: ${specifier}`)
      return import(/* @vite-ignore */ /* webpackIgnore: true */ url.href)
    }
  })
  return { ...composition, skills }
}
