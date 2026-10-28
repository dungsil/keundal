import { createAgentRuntime } from '@keundal/agent-runtime-node'
import { serveSandboxedAgentRuntime } from '@keundal/agent-runtime-node/sandbox-child'
import { createChartTools } from '@keundal/plugin-tool-chart'
import { createWeatherTools } from '@keundal/plugin-tool-weather'

import { createDesktopComposition } from './runtime-plugins.js'

await serveSandboxedAgentRuntime(() => createAgentRuntime(process.env, {
  defaultTools: [...createChartTools(), ...createWeatherTools()],
  compose: createDesktopComposition(process.env.KEUNDAL_MANAGED_PLUGINS)
}))
