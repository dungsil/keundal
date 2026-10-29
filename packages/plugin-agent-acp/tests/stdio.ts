import { readFileSync, writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

let turns = 0
let cwd = ''
let sessionId = ''
let prompts: string[] = []
const app = acp
  .agent()
  .onRequest('initialize', () => ({
    protocolVersion: process.env.BAD_VERSION ? 999 : acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: !!process.env.SESSION_FILE }
  }))
  .onRequest('session/new', ({ params }) => {
    cwd = params.cwd
    sessionId = crypto.randomUUID()
    return { sessionId }
  })
  .onRequest('session/load', async ({ params, client }) => {
    if (process.env.LOAD_ERROR) throw acp.RequestError.invalidParams(undefined, 'session no longer exists')
    const saved = JSON.parse(readFileSync(process.env.SESSION_FILE!, 'utf8'))
    if (params.sessionId !== saved.sessionId || params.cwd !== saved.cwd) {
      throw acp.RequestError.invalidParams(undefined, 'wrong session')
    }
    ;({ turns, cwd, sessionId, prompts } = saved)
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } }
    })
    await client.notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'historical-tool', title: 'inspect', status: 'completed' }
    })
    return {}
  })
  .onRequest('session/prompt', async ({ params, client, signal }) => {
    turns++
    const text = params.prompt.map((part) => (part.type === 'text' ? part.text : '')).join('|')
    prompts.push(text)
    if (process.env.SESSION_FILE) {
      writeFileSync(process.env.SESSION_FILE, JSON.stringify({ turns, cwd, sessionId, prompts }))
    }
    if (text === 'crash') process.exit(2)
    if (text === 'error') throw acp.RequestError.invalidParams(undefined, 'fixture error')
    const update = (update: acp.SessionUpdate) =>
      client.notify('session/update', { sessionId: params.sessionId, update })
    await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'checking' } })
    if (text === 'permission') {
      const result = await client.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'edit', title: 'write_file', kind: 'edit', rawInput: { path: '/project/a' } },
        options: [
          { optionId: 'persist', kind: 'allow_always', name: 'Always' },
          { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
          { optionId: 'yes', kind: 'allow_once', name: 'Allow' }
        ]
      })
      await update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(result.outcome) }
      })
      return { stopReason: 'end_turn' }
    }
    await update({
      sessionUpdate: 'tool_call',
      toolCallId: 'reused-call',
      title: 'inspect',
      status: 'pending',
      rawInput: { value: 'old' }
    })
    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'reused-call',
      status: 'in_progress',
      rawInput: { value: 'new' }
    })
    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'reused-call',
      status: 'completed',
      rawOutput: { count: turns }
    })
    await update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'reused-message',
      content: { type: 'text', text: `${turns}:${text}:${cwd}` }
    })
    if (text === 'wait') {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { stopReason: 'cancelled' }
    }
    await update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'second-message',
      content: { type: 'text', text: '!' }
    })
    return { stopReason: 'end_turn' }
  })
app.connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>)
)
