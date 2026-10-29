import * as acp from '@keundal/ui-acp/plugin'
import * as agentPlugins from '@keundal/ui-agent-plugins/plugin'
import * as automation from '@keundal/ui-automation/plugin'
import * as chat from '@keundal/ui-chat/plugin'
import * as chatList from '@keundal/ui-chat-list/plugin'
import * as chart from '@keundal/ui-chart/plugin'
import * as composer from '@keundal/ui-composer/plugin'
import * as dictation from '@keundal/ui-dictation/plugin'
import * as home from '@keundal/ui-home/plugin'
import * as layout from '@keundal/ui-layout/plugin'
import * as markdown from '@keundal/ui-markdown-comark/plugin'
import * as mcp from '@keundal/ui-mcp/plugin'
import * as memory from '@keundal/ui-memory/plugin'
import * as modelSelection from '@keundal/ui-model-selection/plugin'
import * as settings from '@keundal/ui-settings/plugin'
import * as settingsLlm from '@keundal/ui-settings-llm/plugin'
import * as prompt from '@keundal/ui-settings-llm/prompt-plugin'
import * as skill from '@keundal/ui-skill/plugin'
import * as subagents from '@keundal/ui-subagents/plugin'
import * as tool from '@keundal/ui-tool/plugin'
import * as trace from '@keundal/ui-trace/plugin'
import * as weather from '@keundal/ui-weather/plugin'
import * as workspace from '@keundal/ui-workspace/plugin'
import type { UIPluginEntry } from './ui-plugin-manager'

/** Only the management shell is protected; all other views are selectable. */
export const uiPluginCatalog: readonly UIPluginEntry[] = [
  { module: '@keundal/ui-markdown-comark', plugin: markdown },
  { module: '@keundal/ui-layout', plugin: layout, required: true },
  { module: '@keundal/ui-chat-list', plugin: chatList },
  { module: '@keundal/ui-home', plugin: home },
  { module: '@keundal/ui-chat', plugin: chat },
  { module: '@keundal/ui-composer', plugin: composer },
  { module: '@keundal/ui-workspace', plugin: workspace, requires: ['@keundal/ui-composer'] },
  { module: '@keundal/ui-model-selection', plugin: modelSelection, requires: ['@keundal/ui-settings'] },
  { module: '@keundal/ui-dictation', plugin: dictation, requires: ['@keundal/ui-composer'] },
  { module: '@keundal/ui-trace', plugin: trace, requires: ['@keundal/ui-chat'] },
  // Renderers remain independent of execution tools so saved results can still be read.
  { module: '@keundal/ui-acp', plugin: acp, requires: ['@keundal/ui-chat'] },
  { module: '@keundal/ui-tool', plugin: tool, requires: ['@keundal/ui-chat'] },
  { module: '@keundal/ui-chart', plugin: chart, requires: ['@keundal/ui-chat'] },
  { module: '@keundal/ui-weather', plugin: weather, requires: ['@keundal/ui-chat'] },
  { module: '@keundal/ui-settings', plugin: settings, required: true },
  { module: '@keundal/ui-settings-llm', plugin: settingsLlm, requires: ['@keundal/ui-settings'] },
  { module: '@keundal/ui-settings-llm/prompt-plugin', plugin: prompt, feature: 'prompt', requires: ['@keundal/ui-settings'] },
  { module: '@keundal/ui-subagents', plugin: subagents, feature: 'subagents', requires: ['@keundal/ui-settings'] },
  { module: '@keundal/ui-memory', plugin: memory, requires: ['@keundal/ui-settings'] },
  { module: '@keundal/ui-automation', plugin: automation, requires: ['@keundal/ui-settings'] },
  { module: '@keundal/ui-agent-plugins', plugin: agentPlugins, required: true, requires: ['@keundal/ui-settings'] },
  { module: '@keundal/ui-agent-plugins/agent-plugin-settings', plugin: agentPlugins.agentPluginSettings, requires: ['@keundal/ui-settings'] },
  { module: '@keundal/ui-skill', plugin: skill, feature: 'skills', requires: ['@keundal/ui-settings'] },
  { module: '@keundal/ui-mcp', plugin: mcp, feature: 'mcp', requires: ['@keundal/ui-settings'] }
]

/** Kept for consumers that inspect the bundled plugin registrations. */
export const uiPlugins = uiPluginCatalog.map(entry => entry.plugin)
