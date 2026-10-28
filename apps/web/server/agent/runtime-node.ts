import { createSandboxedAgentRuntime, type SandboxedAgentRuntime } from '@keundal/agent-runtime-node/sandbox'

let runtime: Promise<SandboxedAgentRuntime> | undefined

export async function getAgentApp() {
  const current = runtime ??= (async () => {
    const workerSource = await useStorage('assets:agent-host').getItem<string>('sandbox-worker.txt')
    if (!workerSource) throw new Error('Sandbox worker asset is missing')
    return createSandboxedAgentRuntime({ workerSource })
  })()
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
