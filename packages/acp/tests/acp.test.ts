import { PassThrough, Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { createAcpAgent, createAcpStdioStream, type AcpAgentOptions } from '@keundal/acp'
import { EventType, type AGUIEvent, type RunAgentInput } from '@keundal/core'
import { expect, test, type TestContext } from 'vitest'

const finish = (input: RunAgentInput): AGUIEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: input.threadId,
  runId: input.runId
})
const prompt = (sessionId: string, text = 'hello'): acp.PromptRequest => ({
  sessionId,
  prompt: [{ type: 'text', text }]
})

async function setup(
  t: TestContext,
  createSession: AcpAgentOptions['createSession'],
  permission: (
    context: acp.ClientRequestContext<acp.RequestPermissionRequest>
  ) => Promise<acp.RequestPermissionResponse> = async () => ({ outcome: { outcome: 'cancelled' } })
) {
  const updates: acp.SessionNotification[] = []
  const adapter = createAcpAgent({ createSession })
  const client = acp
    .client()
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params)
    })
    .onRequest(acp.methods.client.session.requestPermission, permission)
  const connection = client.connect(adapter.app)
  t.onTestFinished(() => adapter.dispose())
  const initialized = await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {}
  })
  const newSession = async (cwd = '/workspace') =>
    connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
  return { adapter, connection, updates, initialized, newSession }
}

test('여러 턴의 텍스트와 추론을 전달하고 세션별 실행 입력을 분리한다', async (t) => {
  const backends: { cwd: string; inputs: RunAgentInput[] }[] = []
  const messageIds: string[] = []
  const { connection, updates, newSession } = await setup(t, async ({ cwd }) => {
    const inputs: RunAgentInput[] = []
    backends.push({ cwd, inputs })
    return {
      async *run(input) {
        inputs.push(input)
        const thoughtId = crypto.randomUUID()
        const answerId = crypto.randomUUID()
        messageIds.push(thoughtId, answerId)
        yield { type: EventType.REASONING_MESSAGE_CONTENT, messageId: thoughtId, delta: 'thinking' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: answerId, delta: `${cwd}:${inputs.length}` }
        yield finish(input)
      },
      async dispose() {}
    }
  })
  const first = await newSession('/first')
  const second = await newSession('/second')
  expect(first.sessionId).not.toBe(second.sessionId)
  for (const session of [first, first, second]) {
    await expect(
      connection.agent.request(acp.methods.agent.session.prompt, prompt(session.sessionId))
    ).resolves.toEqual({ stopReason: 'end_turn' })
  }
  expect(backends.map(({ cwd, inputs }) => [cwd, inputs.length])).toEqual([
    ['/first', 2],
    ['/second', 1]
  ])
  const inputs = backends.flatMap((backend) => backend.inputs)
  expect(inputs[0]!.threadId).toBe(inputs[1]!.threadId)
  expect(inputs[0]!.threadId).not.toBe(inputs[2]!.threadId)
  expect(new Set(inputs.map((input) => input.runId)).size).toBe(3)
  expect(new Set(inputs.map((input) => input.messages[0]!.id)).size).toBe(3)
  expect(updates.map(({ sessionId, update }) => [sessionId, update.sessionUpdate])).toEqual([
    [first.sessionId, 'agent_thought_chunk'],
    [first.sessionId, 'agent_message_chunk'],
    [first.sessionId, 'agent_thought_chunk'],
    [first.sessionId, 'agent_message_chunk'],
    [second.sessionId, 'agent_thought_chunk'],
    [second.sessionId, 'agent_message_chunk']
  ])
  expect(updates.at(-1)!.update).toMatchObject({ content: { type: 'text', text: '/second:1' } })
  expect(updates.map(({ update }) => ('messageId' in update ? update.messageId : undefined))).toEqual(messageIds)
})

test('지원하지 않는 기능을 광고하지 않고 잘못된 cwd와 MCP 서버를 실행 전에 거부한다', async (t) => {
  let created = 0
  const { connection, initialized } = await setup(t, async () => {
    created++
    return {
      async *run(input) {
        yield finish(input)
      },
      async dispose() {}
    }
  })
  expect(initialized.agentCapabilities).toEqual({
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false }
  })
  await expect(
    connection.agent.request(acp.methods.agent.session.new, { cwd: 'relative', mcpServers: [] })
  ).rejects.toMatchObject({ code: -32602 })
  await expect(
    connection.agent.request(acp.methods.agent.session.new, {
      cwd: '/workspace',
      mcpServers: [{ name: 'mcp', command: 'server', args: [], env: [] }]
    })
  ).rejects.toMatchObject({ code: -32602 })
  expect(created).toBe(0)
  await expect(
    connection.agent.request(acp.methods.agent.session.load, { sessionId: 'old', cwd: '/workspace', mcpServers: [] })
  ).rejects.toMatchObject({ code: -32601 })
})

test('이미지와 오디오 및 내장 리소스와 알 수 없는 세션은 에이전트를 호출하지 않는다', async (t) => {
  let runs = 0
  const { connection, newSession } = await setup(t, async () => ({
    async *run(input) {
      runs++
      yield finish(input)
    },
    async dispose() {}
  }))
  const { sessionId } = await newSession()
  const blocks: acp.ContentBlock[] = [
    { type: 'image', data: 'AA==', mimeType: 'image/png' },
    { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'file:///test', text: 'content' } }
  ]
  for (const block of blocks) {
    await expect(
      connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'prefix' }, block]
      })
    ).rejects.toMatchObject({ code: -32602 })
  }
  await expect(connection.agent.request(acp.methods.agent.session.prompt, prompt('unknown'))).rejects.toMatchObject({
    code: -32002,
    data: { sessionId: 'unknown' }
  })
  expect(runs).toBe(0)
})

test('resource_link는 파일을 읽지 않고 이름과 URI 및 설명을 텍스트 참조로 보존한다', async (t) => {
  const inputs: RunAgentInput[] = []
  const { connection, newSession } = await setup(t, async () => ({
    async *run(input) {
      inputs.push(input)
      yield finish(input)
    },
    async dispose() {}
  }))
  const { sessionId } = await newSession()
  await connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [
      { type: 'text', text: 'Inspect these references' },
      {
        type: 'resource_link',
        uri: 'file:///does-not-exist/secret.txt',
        name: 'Local reference',
        description: 'Do not read automatically'
      },
      { type: 'resource_link', uri: 'https://example.invalid/reference', name: 'Remote reference' }
    ]
  })
  expect(inputs[0]!.messages[0]!.content).toBe(
    'Inspect these references\nResource: Local reference\nURI: file:///does-not-exist/secret.txt\nDescription: Do not read automatically\nResource: Remote reference\nURI: https://example.invalid/reference'
  )
})

for (const outcome of ['allow_once', 'reject_once', 'cancelled', 'unexpected', 'rpc_error', 'cancel_during'] as const) {
  test(`권한 응답 ${outcome}에서 명시한 allow_once만 도구 실행을 허용한다`, async (t) => {
    let executed = 0
    const requests: acp.RequestPermissionRequest[] = []
    const { connection, updates, newSession } = await setup(
      t,
      async ({ toolApproval }) => ({
        async *run(input, options) {
          const toolCallId = crypto.randomUUID()
          yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: 'write' }
          yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: '{"path":' }
          yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: '"file"}' }
          yield { type: EventType.TOOL_CALL_END, toolCallId }
          const requested = Promise.withResolvers<Extract<AGUIEvent, { type: 'CUSTOM' }>>()
          const authorized = toolApproval.authorize(
            {
              threadId: input.threadId,
              runId: input.runId,
              toolCallId,
              toolName: 'write',
              arguments: { path: 'file' },
              operation: { kind: 'write', paths: ['file'] }
            },
            options!.signal!,
            async (event) => {
              if (event.value.status === 'requested') requested.resolve(event)
            }
          )
          void authorized.catch(() => {})
          try {
            yield await requested.promise
            const allowed = await authorized
            if (allowed) executed++
            yield {
              type: EventType.TOOL_CALL_RESULT,
              messageId: crypto.randomUUID(),
              toolCallId,
              role: 'tool',
              content: allowed ? 'written' : 'denied'
            }
            yield finish(input)
          } finally {
            await authorized.catch(() => {})
          }
        },
        async dispose() {}
      }),
      async ({ params }) => {
        requests.push(params)
        if (outcome === 'rpc_error') throw acp.RequestError.internalError(undefined, 'permission UI failed')
        if (outcome === 'cancel_during') {
          await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: params.sessionId })
          // Even a late positive reply must not override cancellation.
          return { outcome: { outcome: 'selected', optionId: 'allow_once' } }
        }
        return {
          outcome: outcome === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: outcome }
        }
      }
    )
    const { sessionId } = await newSession()
    const response = connection.agent.request(acp.methods.agent.session.prompt, prompt(sessionId))
    if (outcome === 'rpc_error') await expect(response).rejects.toMatchObject({ code: -32603 })
    else await expect(response).resolves.toEqual({ stopReason: outcome === 'cancel_during' ? 'cancelled' : 'end_turn' })
    expect(executed).toBe(outcome === 'allow_once' ? 1 : 0)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.options).toMatchObject([
      { optionId: 'allow_once', kind: 'allow_once' },
      { optionId: 'reject_once', kind: 'reject_once' }
    ])
    expect(updates[0]!.update).toMatchObject({ sessionUpdate: 'tool_call', status: 'pending', title: 'write' })
    expect(
      updates.some(({ update }) => 'rawInput' in update && JSON.stringify(update.rawInput) === '{"path":"file"}')
    ).toBe(true)
    expect(updates.at(-1)!.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      status: outcome === 'allow_once' ? 'completed' : 'failed'
    })
    if (outcome !== 'rpc_error' && outcome !== 'cancel_during') {
      expect(updates.at(-1)!.update).toMatchObject({
        content: [{ type: 'content', content: { type: 'text', text: outcome === 'allow_once' ? 'written' : 'denied' } }]
      })
    }
  })
}

test('RUN_ERROR와 예외 및 종료 이벤트 누락은 성공 응답으로 바꾸지 않고 재실행하지 않는다', async (t) => {
  let runs = 0
  const { connection, updates, newSession } = await setup(t, async () => ({
    async *run() {
      runs++
      if (runs === 3) return
      yield { type: EventType.TOOL_CALL_START, toolCallId: `call-${runs}`, toolCallName: 'broken' }
      if (runs === 1) yield { type: EventType.RUN_ERROR, message: 'provider failed', code: 'PROVIDER' }
      else throw new Error('backend failed')
    },
    async dispose() {}
  }))
  const { sessionId } = await newSession()
  for (let index = 0; index < 3; index++) {
    await expect(connection.agent.request(acp.methods.agent.session.prompt, prompt(sessionId))).rejects.toMatchObject({
      code: -32603
    })
  }
  expect(runs).toBe(3)
  expect(updates.filter(({ update }) => 'status' in update && update.status === 'failed')).toHaveLength(2)
})

test('실행 중 같은 세션의 중복 요청을 거부하고 취소 후 다음 턴을 실행한다', async (t) => {
  const started = Promise.withResolvers<void>()
  let runs = 0
  let cleaned = 0
  const { connection, newSession } = await setup(t, async () => ({
    async *run(input, options) {
      runs++
      if (runs === 1) {
        try {
          started.resolve()
          await new Promise<void>((resolve) =>
            options!.signal!.addEventListener('abort', () => resolve(), { once: true })
          )
          options!.signal!.throwIfAborted()
        } finally {
          cleaned++
        }
      }
      yield finish(input)
    },
    async dispose() {}
  }))
  const { sessionId } = await newSession()
  const running = connection.agent.request(acp.methods.agent.session.prompt, prompt(sessionId))
  await started.promise
  await expect(connection.agent.request(acp.methods.agent.session.prompt, prompt(sessionId))).rejects.toMatchObject({
    code: -32600
  })
  await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
  await expect(running).resolves.toEqual({ stopReason: 'cancelled' })
  expect(cleaned).toBe(1)
  await expect(connection.agent.request(acp.methods.agent.session.prompt, prompt(sessionId))).resolves.toEqual({
    stopReason: 'end_turn'
  })
  expect(runs).toBe(2)
})

test('연결 종료는 실행을 취소하고 모든 백엔드를 한 번만 정리한다', async (t) => {
  const started = Promise.withResolvers<void>()
  let aborted = false
  let disposed = 0
  const { adapter, connection, newSession } = await setup(t, async () => ({
    async *run(input, options) {
      started.resolve()
      await new Promise<void>((resolve) =>
        options!.signal!.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true }
        )
      )
      options!.signal!.throwIfAborted()
      yield finish(input)
    },
    async dispose() {
      disposed++
    }
  }))
  const { sessionId } = await newSession()
  await newSession('/other')
  const running = connection.agent.request(acp.methods.agent.session.prompt, prompt(sessionId))
  const rejected = expect(running).rejects.toThrow()
  await started.promise
  connection.close()
  await rejected
  await adapter.dispose()
  await adapter.dispose()
  expect(aborted).toBe(true)
  expect(disposed).toBe(2)
})

test('백엔드 생성 도중 종료해도 늦게 생성된 자원을 정리한다', async (t) => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let disposed = 0
  const { adapter, newSession } = await setup(t, async () => {
    started.resolve()
    await release.promise
    return {
      async *run(input) {
        yield finish(input)
      },
      async dispose() {
        disposed++
      }
    }
  })
  const creating = newSession()
  const rejected = expect(creating).rejects.toThrow()
  await started.promise
  const disposing = adapter.dispose()
  release.resolve()
  await disposing
  await rejected
  expect(disposed).toBe(1)
})

test('stdio 래퍼는 실제 NDJSON 연결에서 JSON-RPC 메시지만 출력한다', async (t) => {
  const input = new PassThrough()
  const incoming = new PassThrough()
  const chunks: string[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      incoming.write(chunk, callback)
    }
  })
  const adapter = createAcpAgent({
    createSession: async () => ({
      async *run(input) {
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: crypto.randomUUID(), delta: 'answer' }
        yield finish(input)
      },
      async dispose() {}
    })
  })
  adapter.app.connect(createAcpStdioStream(input, output))
  const updates: acp.SessionNotification[] = []
  const connection = acp
    .client()
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params)
    })
    .connect(acp.ndJsonStream(Writable.toWeb(input), Readable.toWeb(incoming)))
  t.onTestFinished(async () => {
    connection.close()
    await adapter.dispose()
    input.destroy()
    incoming.destroy()
    output.destroy()
  })
  await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION })
  const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, {
    cwd: '/workspace',
    mcpServers: []
  })
  await connection.agent.request(acp.methods.agent.session.prompt, prompt(sessionId))
  expect(updates[0]!.update).toMatchObject({ content: { text: 'answer' } })
  const lines = chunks
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(lines.length).toBeGreaterThanOrEqual(4)
  expect(lines.every((line) => line.jsonrpc === '2.0')).toBe(true)
})
