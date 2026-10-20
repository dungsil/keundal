import { disposeAgentRuntime } from '#agent-host-runtime'

export default defineNitroPlugin((app) => {
  app.hooks.hook('close', disposeAgentRuntime)
})
