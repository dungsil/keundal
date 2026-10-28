import process from 'node:process'

import { createAgentRuntime, createNodeComposition } from './index.js'
import { serveSandboxedAgentRuntime } from './sandbox-child.js'

await serveSandboxedAgentRuntime(() => createAgentRuntime(process.env, { compose: createNodeComposition }))
