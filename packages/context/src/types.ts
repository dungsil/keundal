import { CONTEXT_MESSAGE_PREFIX, type AgentMessage, type ExecutionOptions, type RunAgentInput } from '@keundal/core'

export { CONTEXT_MESSAGE_PREFIX } from '@keundal/core'

export interface ContextOptions extends ExecutionOptions {
  readonly step: number
  readonly request: RunAgentInput
  readonly contextWindow?: number
}

export type ContextProvider = (input: RunAgentInput, options: ContextOptions) => RunAgentInput | Promise<RunAgentInput>

export type ContextMessage = Extract<AgentMessage, { role: 'user' }> & { content: string }

export function contextMessage(key: string, content: string): ContextMessage {
  return {
    id: `${CONTEXT_MESSAGE_PREFIX}${encodeURIComponent(key)}:${globalThis.crypto.randomUUID()}`,
    role: 'user',
    content
  }
}

export function latestContextMessage(input: RunAgentInput, key: string): ContextMessage | undefined {
  const prefix = `${CONTEXT_MESSAGE_PREFIX}${encodeURIComponent(key)}:`
  return input.messages.findLast(
    (message): message is ContextMessage =>
      message.role === 'user' && typeof message.content === 'string' && message.id.startsWith(prefix)
  )
}

export function appendContext(input: RunAgentInput, key: string, content: string): RunAgentInput {
  if (latestContextMessage(input, key)?.content === content) return input
  return { ...input, messages: [...input.messages, contextMessage(key, content)] }
}
