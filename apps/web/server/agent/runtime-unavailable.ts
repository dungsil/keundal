import type { RequestListener } from 'node:http'

export async function getAgentApp(): Promise<RequestListener> {
  throw new Error('The local agent host requires Node.js')
}

export async function disposeAgentRuntime() {}
