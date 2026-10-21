import { createAgentRuntime, createNodeComposition, type AgentRuntime } from '@keundal/agent-runtime-node'

let runtime: Promise<AgentRuntime> | undefined

export async function getAgentApp() {
  const current = runtime ??= createAgentRuntime(process.env, { compose: createNodeComposition })
  try {
    return (await current).app
  } catch (error) {
    if (runtime === current) runtime = undefined
    throw error
  }
}

export async function disposeAgentRuntime() {
  const current = runtime
  runtime = undefined
  await current?.then(host => host.dispose(), () => {})
}
