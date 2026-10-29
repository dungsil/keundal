import { uiPluginCatalog as sharedPlugins } from '@keundal/chat-app/ui-plugins'
import * as workspace from '@keundal/ui-workspace/plugin'

export const uiPluginCatalog = [
  ...sharedPlugins,
  { module: '@keundal/ui-workspace', plugin: workspace, requires: ['@keundal/ui-composer'] }
]
