import { createUIPlugin } from '@keundal/ui-runtime/nuxt'
import { uiPluginCatalog } from '../ui-plugins'

export default defineNuxtPlugin(createUIPlugin(uiPluginCatalog))
