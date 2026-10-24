import * as agentPlugins from '@keundal/ui-agent-plugins/plugin'
import * as chat from '@keundal/ui-chat/plugin'
import * as chatList from '@keundal/ui-chat-list/plugin'
import * as composer from '@keundal/ui-composer/plugin'
import * as dictation from '@keundal/ui-dictation/plugin'
import * as home from '@keundal/ui-home/plugin'
import * as layout from '@keundal/ui-layout/plugin'
import * as mcp from '@keundal/ui-mcp/plugin'
import * as modelSelection from '@keundal/ui-model-selection/plugin'
import * as settings from '@keundal/ui-settings/plugin'
import * as settingsLlm from '@keundal/ui-settings-llm/plugin'
import * as skill from '@keundal/ui-skill/plugin'
import * as tool from '@keundal/ui-tool/plugin'
import * as trace from '@keundal/ui-trace/plugin'

/**
 * UI plugins loaded into every application instance. Plugins contribute to slots declared by other plugins through
 * `ctx.slots.inject`, so the order does not change the result.
 */
export const uiPlugins = [
  layout,
  chatList,
  home,
  chat,
  composer,
  modelSelection,
  dictation,
  trace,
  tool,
  settings,
  settingsLlm,
  agentPlugins,
  skill,
  mcp
]
