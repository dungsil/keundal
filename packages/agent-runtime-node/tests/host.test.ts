import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventType, type AGUIEvent } from '@keundal/core'
import { type LLMEvent } from '@keundal/llm'
import { readTraceSpans, summarizeTrace } from '@keundal/trace'
import { afterEach, expect, test } from 'vitest'

import { createNodeAgentHost, createNodeComposition, createAgentRuntime } from '../src/index.js'
const createAgentHost = (options: Parameters<typeof createNodeAgentHost>[0]) =>
  createNodeAgentHost(options, createNodeComposition)

const directories: string[] = []
const hosts: Awaited<ReturnType<typeof createAgentHost>>[] = []

const sqlitePath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-agent-host-'))
  directories.push(directory)
  return join(directory, 'store.sqlite')
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('프로젝트 메모리를 에이전트 도구로 저장하고 호스트 재시작 후 새 대화에서 출처와 함께 검색한다', async () => {
  const path = sqlitePath()
  const decision = {
    title: '프로젝트 저장소 결정',
    content: 'SQLite WAL로 영속성을 제공한다',
    sources: [{ uri: 'https://example.com/decisions/42', label: '설계 결정' }]
  }
  const open = async (projectId: string) => {
    const host = await createAgentRuntime(
      {
        KEUNDAL_PROVIDER: 'openai',
        KEUNDAL_MODEL: 'test',
        KEUNDAL_SQLITE_PATH: path,
        KEUNDAL_API_TOKEN: 'memory-test-token',
        KEUNDAL_PROJECT_ID: projectId
      },
      { compose: createNodeComposition, subagents: false }
    )
    hosts.push(host)
    host.ctx.llm.countTokens = async () => 20
    host.ctx.llm.stream = async function* (request): AsyncIterable<LLMEvent> {
      const result = request.input.messages.find((message) => message.role === 'tool')
      if (result) {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: String(result.content) }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
        return
      }
      const save = request.input.messages.some((message) => message.role === 'user' && message.content === 'save')
      const name = save ? 'memory_save' : 'memory_search'
      expect(request.input.tools.some((tool) => tool.name === name)).toBe(true)
      yield { type: EventType.TOOL_CALL_START, toolCallId: 'memory-call', toolCallName: name }
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: 'memory-call',
        delta: JSON.stringify(save ? decision : { query: '결정 sqlite' })
      }
      yield { type: EventType.TOOL_CALL_END, toolCallId: 'memory-call' }
    }
    return host
  }
  const run = async (host: Awaited<ReturnType<typeof open>>, threadId: string, command: string) => {
    const events = []
    for await (const event of host.services.run({
      threadId,
      runId: `${threadId}-run`,
      state: {},
      tools: [],
      context: [],
      messages: [{ id: 'user', role: 'user', content: command }]
    }))
      events.push(event)
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    const session = await host.services.session.get(threadId)
    const result = session?.messages.find((message) => message.role === 'tool')
    return JSON.parse(String(result?.content))
  }
  const first = await open('keundal')
  expect((await first.services.catalog?.())?.tools.map((tool) => tool.name)).toEqual([
    'memory_search',
    'memory_get',
    'memory_save',
    'memory_update',
    'memory_delete'
  ])
  const saved = await run(first, 'first-conversation', 'save')
  expect(saved).toMatchObject({
    ...decision,
    sources: [
      ...decision.sources,
      { uri: 'keundal://threads/first-conversation/runs/first-conversation-run', label: 'Conversation' }
    ]
  })
  const original = await first.services.session.get('first-conversation')
  await first.services.session.delete('first-conversation', original!.revision)
  await first.dispose()
  const second = await open('keundal')
  expect(await run(second, 'new-conversation', 'search')).toEqual([saved])
  await second.dispose()
  const unrelated = await open('unrelated-project')
  expect(await run(unrelated, 'other-project-conversation', 'search')).toEqual([])
})

test('외부 매니페스트가 파일과 import 전용 패키지를 불러오고 사용자 공급자를 유지한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-runtime-plugins-'))
  directories.push(directory)
  const pluginDirectory = join(directory, 'plugins')
  const packageDirectory = join(directory, 'node_modules', 'runtime-fixture')
  mkdirSync(pluginDirectory, { recursive: true })
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(
    join(pluginDirectory, 'llm.mjs'),
    `export default Object.assign(ctx => {
    ctx.provide('llm', {
      async getModel() { return { contextWindow: 128000, maxOutputTokens: 4096 } },
      async countTokens() { return 10 },
      async *stream(request) {
        const result = request.input.messages.find(message => message.role === 'tool')
        if (!result) {
          yield { type: 'TOOL_CALL_START', toolCallId: 'manifest-call', toolCallName: 'manifest_tool' }
          yield { type: 'TOOL_CALL_ARGS', toolCallId: 'manifest-call', delta: '{}' }
          yield { type: 'TOOL_CALL_END', toolCallId: 'manifest-call' }
          return
        }
        yield { type: 'TEXT_MESSAGE_START', messageId: 'external-answer', role: 'assistant' }
        yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'external-answer', delta: ctx.runtimeFixture.prefix + result.content }
        yield { type: 'TEXT_MESSAGE_END', messageId: 'external-answer' }
      }
    })
  }, { inject: ['runtimeFixture'] })`
  )
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: 'runtime-fixture', type: 'module', exports: { import: './index.mjs' } })
  )
  writeFileSync(
    join(packageDirectory, 'index.mjs'),
    "export default (ctx, config) => { ctx.provide('runtimeFixture', { prefix: config.prefix }) }"
  )
  writeFileSync(
    join(pluginDirectory, 'tools.mjs'),
    "export function createTools(config) { return [{ name: 'manifest_tool', description: config.description, parameters: { type: 'object' }, execute: async () => 'runtime-tool-result' }] }"
  )
  const manifestPath = join(directory, 'keundal.plugins.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      plugins: [
        { module: 'runtime-fixture', config: { prefix: 'external-package: ' } },
        { module: './plugins/llm.mjs' },
        { module: 'builtin:store', config: { path: join(directory, 'store.sqlite') } }
      ],
      agent: { module: 'builtin:agent', config: { subagents: false } },
      tools: [{ module: './plugins/tools.mjs', export: 'createTools', config: { description: 'Manifest tool' } }]
    })
  )
  const runtime = await createAgentRuntime(
    {
      KEUNDAL_PROVIDER: 'external-provider',
      KEUNDAL_MODEL: 'custom-model',
      KEUNDAL_API_TOKEN: 'runtime-test-token',
      KEUNDAL_PLUGIN_CONFIG: manifestPath
    },
    {
      compose: createNodeComposition,
      defaultTools: [
        { name: 'default-tool', description: 'Default', parameters: { type: 'object' }, execute: async () => '' }
      ],
      tools: [{ name: 'option-tool', description: 'Option', parameters: { type: 'object' }, execute: async () => '' }]
    }
  )
  hosts.push(runtime)
  expect(runtime.services.models()).toEqual([
    { id: 'custom-model', provider: 'external-provider', contextWindow: 128000, maxOutputTokens: 4096 }
  ])
  expect((await runtime.services.catalog?.())?.tools.map(({ name }) => name)).toEqual(['manifest_tool', 'option-tool'])
  const events = []
  for await (const event of runtime.services.run({
    threadId: 'manifest-thread',
    runId: 'manifest-run',
    state: {},
    tools: [],
    context: [],
    messages: [{ id: 'user', role: 'user', content: 'Use the configured tool' }]
  }))
    events.push(event)
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect((await runtime.services.session.get('manifest-thread'))?.messages).toContainEqual(
    expect.objectContaining({ role: 'assistant', content: 'external-package: runtime-tool-result' })
  )
})

function pricingManifest(directory: string, pricing: unknown) {
  const pluginDirectory = join(directory, 'plugins')
  mkdirSync(pluginDirectory, { recursive: true })
  writeFileSync(
    join(pluginDirectory, 'llm.mjs'),
    `export default ctx => {
    ctx.provide('llm', {
      async getModel() { return { contextWindow: 128000, maxOutputTokens: 4096 } },
      async countTokens() { return 10 },
      async *stream() {
        yield { type: 'TEXT_MESSAGE_START', messageId: 'priced-answer', role: 'assistant' }
        yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'priced-answer', delta: 'done' }
        yield { type: 'TEXT_MESSAGE_END', messageId: 'priced-answer' }
        yield { type: 'CUSTOM', name: 'keundal.llm.usage', value: { source: 'provider', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400 } }
      }
    })
  }`
  )
  const manifestPath = join(directory, 'keundal.plugins.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      plugins: [
        { module: './plugins/llm.mjs' },
        { module: 'builtin:store', config: { path: join(directory, 'store.sqlite') } }
      ],
      agent: { module: 'builtin:agent', config: { subagents: false, pricing } }
    })
  )
  return {
    KEUNDAL_PROVIDER: 'external-provider',
    KEUNDAL_MODEL: 'custom-model',
    KEUNDAL_API_TOKEN: 'runtime-test-token',
    KEUNDAL_PLUGIN_CONFIG: manifestPath
  }
}

test('매니페스트의 agent.config.pricing으로 공급자가 비용을 주지 않는 모델의 추정 비용을 Trace에 기록한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-pricing-'))
  directories.push(directory)
  const runtime = await createAgentRuntime(
    pricingManifest(directory, {
      currency: 'USD',
      models: { 'custom-model': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 } }
    }),
    { compose: createNodeComposition }
  )
  hosts.push(runtime)
  const events: AGUIEvent[] = []
  for await (const event of runtime.services.run({
    threadId: 'pricing-thread',
    runId: 'pricing-run',
    state: {},
    tools: [],
    context: [],
    messages: [{ id: 'user', role: 'user', content: 'Price this run' }]
  }))
    events.push(event)
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  const cost = summarizeTrace(readTraceSpans(events, 'pricing-run')).cost
  // 일반 입력 600 × 3 + 캐시 읽기 400 × 0.3 + 출력 200 × 15 (100만 토큰 기준)
  expect(cost).toMatchObject({ currency: 'USD', complete: true, source: 'estimate' })
  expect(cost?.amount).toBeCloseTo(0.00492, 9)
})

test('매니페스트의 잘못된 가격표는 기본 가격으로 대체하지 않고 첫 실행을 거부한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-pricing-invalid-'))
  directories.push(directory)
  const runtime = await createAgentRuntime(
    pricingManifest(directory, {
      currency: 'USD',
      models: { 'custom-model': { inputPerMillion: -1, outputPerMillion: 1 } }
    }),
    { compose: createNodeComposition }
  )
  hosts.push(runtime)
  const events: AGUIEvent[] = []
  await expect(
    (async () => {
      for await (const event of runtime.services.run({
        threadId: 'invalid-pricing-thread',
        runId: 'invalid-pricing-run',
        state: {},
        tools: [],
        context: [],
        messages: [{ id: 'user', role: 'user', content: 'Price this run' }]
      }))
        events.push(event)
    })()
  ).rejects.toThrow('pricing.models.custom-model.inputPerMillion must be a non-negative number')
  expect(events).toEqual([])
})

test('매니페스트에 tools가 없으면 defaultTools와 options.tools를 함께 제공한다', async () => {
  const host = await createAgentRuntime(
    {
      KEUNDAL_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      KEUNDAL_MODEL: 'small',
      KEUNDAL_API_TOKEN: 'runtime-test-token',
      KEUNDAL_SQLITE_PATH: sqlitePath()
    },
    {
      compose: createNodeComposition,
      runtimePlugins: {
        plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }],
        agent: { module: 'builtin:agent' }
      },
      defaultTools: [
        { name: 'default-tool', description: 'Default', parameters: { type: 'object' }, execute: async () => '' }
      ],
      tools: [{ name: 'option-tool', description: 'Option', parameters: { type: 'object' }, execute: async () => '' }]
    }
  )
  hosts.push(host)
  expect((await host.services.catalog?.())?.tools.map(({ name }) => name)).toEqual(['default-tool', 'option-tool'])
})

test('명시한 매니페스트 파일이 없으면 기본 구성을 사용하지 않는다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-missing-manifest-'))
  directories.push(directory)
  await expect(
    createAgentRuntime(
      { KEUNDAL_PROVIDER: 'openai', KEUNDAL_MODEL: 'test', KEUNDAL_PLUGIN_CONFIG: join(directory, 'missing.json') },
      { compose: createNodeComposition }
    )
  ).rejects.toThrow('failed to read runtime plugin manifest')
})

test('builtin LLM은 알 수 없는 공급자를 기본값으로 대체하지 않는다', async () => {
  await expect(
    createAgentRuntime(
      { KEUNDAL_PROVIDER: 'unknown-provider', KEUNDAL_MODEL: 'small' },
      {
        compose: createNodeComposition,
        runtimePlugins: {
          plugins: [{ module: 'builtin:llm' }],
          agent: { module: 'builtin:agent' }
        }
      }
    )
  ).rejects.toThrow('unsupported KEUNDAL_PROVIDER for builtin:llm: unknown-provider')
})

test('플러그인 setup 오류가 먼저 등록한 정리 효과를 실행한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-runtime-cleanup-'))
  directories.push(directory)
  const cleanupKey = '__keundal_runtime_cleanup_test__'
  const globalState = globalThis as typeof globalThis & { __keundal_runtime_cleanup_test__?: string[] }
  globalState[cleanupKey] = []
  writeFileSync(
    join(directory, 'cleanup.mjs'),
    `export default ctx => ctx.effect(() => () => globalThis.${cleanupKey}.push('disposed'))`
  )
  writeFileSync(join(directory, 'fail.mjs'), "export default () => { throw new Error('fixture setup failure') }")
  try {
    await expect(
      createAgentRuntime(
        { KEUNDAL_PROVIDER: 'openai', KEUNDAL_MODEL: 'test' },
        {
          compose: createNodeComposition,
          runtimePluginBasePath: directory,
          runtimePlugins: {
            plugins: [{ module: './cleanup.mjs' }, { module: './fail.mjs' }],
            agent: { module: 'builtin:agent' }
          }
        }
      )
    ).rejects.toThrow('fixture setup failure')
    expect(globalState[cleanupKey]).toEqual(['disposed'])
  } finally {
    delete globalState[cleanupKey]
  }
})

test('외부 에이전트는 설정한 모델 예산을 유지하며 생성한 답변을 저장한다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-runtime-agent-'))
  directories.push(directory)
  writeFileSync(
    join(directory, 'agent.mjs'),
    `export default Object.assign((ctx, config) => {
    ctx.provide('agent', { async *run(input, execution) {
      const prepared = await ctx.session.prepare(input, execution)
      yield* ctx.generation.run({ input: prepared.input, sessionRevision: prepared.revision, model: config.model, maxOutputTokens: config.maxOutputTokens }, {
        ...execution,
        stream: async function* () {
          yield { type: 'TEXT_MESSAGE_START', messageId: 'custom-answer', role: 'assistant' }
          yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'custom-answer', delta: config.label + ':' + config.model + ':' + config.maxOutputTokens }
          yield { type: 'TEXT_MESSAGE_END', messageId: 'custom-answer' }
        }
      })
    } })
  }, { inject: ['session', 'generation'] })`
  )
  const host = await createNodeAgentHost(
    {
      provider: 'openai',
      apiKey: '',
      model: 'small',
      models: { small: { contextWindow: 8000, maxOutputTokens: 500 } },
      maxOutputTokens: 2000,
      sqlitePath: ':memory:',
      runtimePluginBasePath: directory,
      runtimePlugins: {
        plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }],
        agent: { module: './agent.mjs', config: { label: 'external', model: 'wrong', maxOutputTokens: 9000 } }
      }
    },
    createNodeComposition
  )
  hosts.push(host)
  const events = []
  for await (const event of host.services.run({
    threadId: 'external-agent-thread',
    runId: 'external-agent-run',
    state: {},
    tools: [],
    context: [],
    messages: [{ id: 'user', role: 'user', content: 'Run the configured agent' }]
  }))
    events.push(event)
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect((await host.services.session.get('external-agent-thread'))?.messages).toContainEqual(
    expect.objectContaining({ role: 'assistant', content: 'external:small:500' })
  )
})
test('설정한 모델 목록과 기본 모델을 노출한다', async () => {
  const host = await createAgentHost({
    provider: 'openai',
    apiKey: 'test-key',
    model: 'small',
    models: {
      small: { contextWindow: 8000, maxOutputTokens: 1000 },
      large: { contextWindow: 16000, maxOutputTokens: 2000 }
    },
    sqlitePath: sqlitePath()
  })
  hosts.push(host)

  expect(host.model).toBe('small')
  expect(host.services.models()).toEqual([
    { id: 'small', provider: 'openai', contextWindow: 8000, maxOutputTokens: 1000 },
    { id: 'large', provider: 'openai', contextWindow: 16000, maxOutputTokens: 2000 }
  ])
})

test('설정에 없는 모델로 실행하면 거부한다', async () => {
  const host = await createAgentHost({
    provider: 'openai',
    apiKey: 'test-key',
    model: 'small',
    models: { small: { contextWindow: 8000, maxOutputTokens: 1000 } },
    sqlitePath: sqlitePath()
  })
  hosts.push(host)

  expect(() =>
    host.services.run(
      {
        threadId: 'thread',
        runId: 'run',
        state: {},
        tools: [],
        context: [],
        messages: []
      },
      { model: 'missing' }
    )
  ).toThrow('model is not configured')
})

test('기본 모델이 모델 목록에 없으면 호스트 생성을 거부한다', async () => {
  await expect(
    createAgentHost({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'missing',
      models: { small: { contextWindow: 8000, maxOutputTokens: 1000 } },
      sqlitePath: sqlitePath()
    })
  ).rejects.toThrow('default model is not configured')
})

test.each(['array', 'provider', 'deferred'])(
  '호스트는 기본 도구(%s)와 MCP 도구를 함께 제공하고 제목을 생성한다',
  async (kind) => {
    const http = await import('node:http')
    const replies: string[] = []
    const requests: string[] = []
    const server = http.createServer((request, response) => {
      if (request.url === '/v1/responses/input_tokens') {
        response.writeHead(404).end()
        return
      }
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        requests.push(body)
        const title = body.includes('Generate a chat title')
        const text = title ? '테스트 제목' : '테스트 응답'
        replies.push(text)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(
          `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } })}\n\n`
        )
        response.write(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text })}\n\n`
        )
        response.write(
          `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } })}\n\n`
        )
        response.write(
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: 'test', output: [], parallel_tool_calls: false, tool_choice: 'auto', tools: [] } })}\n\n`
        )
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind a port')
    const host = await createAgentHost({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'test',
      models: { test: { contextWindow: 8000, maxOutputTokens: 1000 } },
      sqlitePath: sqlitePath(),
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      ...(kind === 'deferred'
        ? {
            runtimePlugins: {
              plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }],
              agent: { module: 'builtin:agent', config: { deferredTools: {} } }
            }
          }
        : {}),
      tools:
        kind === 'provider'
          ? async () => [
              { name: 'local_tool', description: 'Local', parameters: { type: 'object' }, execute: async () => '{}' }
            ]
          : [{ name: 'local_tool', description: 'Local', parameters: { type: 'object' }, execute: async () => '{}' }],
      mcpServers: [
        {
          serverName: 'fixture',
          transport: 'stdio',
          command: process.execPath,
          args: [
            '-e',
            `
        const readline = require('node:readline');
        readline.createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          const result = request.method === 'initialize'
            ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            : { tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } }] };
          console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        });
      `
          ],
          permissions: { tools: ['search'] },
          timeoutMs: 3000
        }
      ]
    })
    hosts.push(host)
    try {
      const abort = new AbortController()
      const cancelled = expect(host.services.catalog!({ signal: abort.signal })).rejects.toThrow('dismissed')
      await Promise.resolve()
      const catalog = host.services.catalog!()
      abort.abort(new Error('dismissed'))
      await cancelled
      expect(await catalog).toEqual({
        skills: [],
        tools: [
          { name: 'local_tool', description: 'Local' },
          { name: 'mcp__fixture__tool__search', description: 'Search' }
        ]
      })
      expect(requests).toEqual([])
      const events = []
      for await (const event of host.services.run({
        threadId: 'thread',
        runId: 'run',
        state: {},
        tools: [],
        context: [],
        messages: [{ id: 'user', role: 'user', content: '안녕하세요' }]
      })) {
        events.push(event)
      }
      expect(events).toContainEqual({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_1', delta: '테스트 응답' })
      expect(events.at(-1)?.type).toBe('RUN_FINISHED')
      expect((await host.services.session.get('thread'))?.messages).toEqual([
        expect.objectContaining({ role: 'assistant' })
      ])
      const title = await host.services.title({
        model: 'test',
        message: { id: 'user', role: 'user', content: '안녕하세요' }
      })
      expect(title).toBe('테스트 제목')
      const initial = requests.find((body) => !body.includes('Generate a chat title'))!
      if (kind === 'deferred') {
        expect(initial).toContain('search_tool')
        expect(initial).not.toContain('mcp__fixture__tool__search')
      } else expect(initial).toContain('mcp__fixture__tool__search')
      expect(requests.find((body) => body.includes('Generate a chat title'))).not.toContain(
        'mcp__fixture__tool__search'
      )
      expect(requests.find((body) => !body.includes('Generate a chat title'))).toContain('local_tool')
      expect(requests.find((body) => body.includes('Generate a chat title'))).not.toContain('local_tool')
      expect(replies).toEqual(['테스트 응답', '테스트 제목'])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
)

test.for([false, true])(
  'MCP가 없는 런타임도 Deferred Tools=%s에서 직접 도구를 실행하고 답변을 저장한다',
  async (deferred, t) => {
    const { createServer } = await import('node:http')
    const requests: Record<string, unknown>[] = []
    const executions: Record<string, unknown>[] = []
    const server = createServer(async (request, response) => {
      if (request.url === '/v1/responses/input_tokens') {
        response.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      const parsed = JSON.parse(body) as Record<string, unknown>
      requests.push(parsed)
      const followup = (parsed.input as { type?: string }[]).some((item) => item.type === 'function_call_output')
      const item = followup
        ? {
            id: 'answer',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '보르도는 흐립니다.', annotations: [] }]
          }
        : {
            id: 'weather_call',
            type: 'function_call',
            call_id: 'call_1',
            name: 'weather',
            arguments: '{"location":"Bordeaux"}',
            status: 'completed'
          }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'response', status: 'completed' } }
      ])
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.onTestFinished(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        })
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind a port')
    const host = await createAgentRuntime(
      {
        KEUNDAL_PROVIDER: 'openai',
        KEUNDAL_API_TOKEN: 'test-token',
        OPENAI_API_KEY: 'test-key',
        KEUNDAL_MODEL: 'test',
        KEUNDAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        KEUNDAL_SQLITE_PATH: sqlitePath()
      },
      {
        compose: createNodeComposition,
        ...(deferred
          ? {
              runtimePlugins: {
                plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }],
                agent: { module: 'builtin:agent', config: { deferredTools: {} } }
              }
            }
          : {}),
        tools: [
          {
            name: 'weather',
            description: 'Test weather',
            parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
            execute: async (args) => {
              executions.push(args)
              return '{"condition":"cloudy"}'
            }
          }
        ]
      }
    )
    hosts.push(host)
    const events = []
    for await (const event of host.services.run({
      threadId: 'weather-thread',
      runId: 'weather-run',
      state: {},
      tools: [],
      context: [],
      messages: [{ id: 'user', role: 'user', content: '보르도의 날씨는 어떤가요?' }]
    }))
      events.push(event)
    expect(executions).toEqual([{ location: 'Bordeaux' }])
    expect(requests).toHaveLength(2)
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({ name: 'weather', type: 'function' }),
      expect.objectContaining({ name: 'delegate_task', type: 'function' }),
      expect.objectContaining({ name: 'get_background_task', type: 'function' }),
      expect.objectContaining({ name: 'cancel_background_task', type: 'function' }),
      ...(deferred ? [expect.objectContaining({ name: 'search_tool', type: 'function' })] : [])
    ])
    expect(requests[1]?.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"condition":"cloudy"}'
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'TEXT_MESSAGE_CONTENT', delta: '보르도는 흐립니다.' })
    )
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
    expect(await host.services.generation.get('weather-run')).toMatchObject({ status: 'completed' })
  }
)

test('Agent Plugin 스킬을 호스트에 등록하고 종료하면 사용할 수 없다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-host-plugins-'))
  directories.push(directory)
  const root = join(directory, 'plugin')
  mkdirSync(join(root, 'skills', 'hello'), { recursive: true })
  writeFileSync(
    join(root, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'test'
    })
  )
  writeFileSync(join(root, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: Test\n---\nHello')
  const host = await createAgentHost({
    provider: 'openai',
    apiKey: 'test',
    model: 'small',
    sqlitePath: sqlitePath(),
    plugins: [{ root, dataDirectory: join(directory, 'data') }]
  })
  hosts.push(host)
  expect(host.plugins).toHaveLength(1)
  expect((await host.ctx.skills.prepare()).skills).toEqual([{ name: 'hello', description: 'Test' }])
  expect(await host.services.catalog?.()).toEqual({ skills: [{ name: 'hello', description: 'Test' }], tools: [] })
  const catalog = await host.ctx.skills.prepare()
  await host.dispose()
  await expect(catalog.load('hello')).rejects.toThrow()
})

test('같은 모델의 추론 수준을 바꾸면 캐시된 에이전트에도 새 수준을 적용한다', async (t) => {
  const { createServer } = await import('node:http')
  const received: unknown[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.url?.endsWith('/input_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
      return
    }
    received.push(JSON.parse(body).reasoning)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  const host = await createAgentHost({
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-5',
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    sqlitePath: sqlitePath()
  })
  hosts.push(host)
  for (const [index, reasoning] of (['low', 'high', 'medium', 'low'] as const).entries()) {
    const events = []
    for await (const event of host.services.run(
      {
        threadId: `levels-${index}`,
        runId: `levels-${index}`,
        state: {},
        tools: [],
        context: [],
        messages: [{ id: 'user', role: 'user', content: 'hello' }]
      },
      { reasoning }
    ))
      events.push(event)
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
  }
  expect(received).toEqual(['low', 'high', 'medium', 'low'].map((effort) => ({ effort, summary: 'auto' })))
})

test('자동화 HTTP API는 인증 뒤 Webhook과 이름 기반 이벤트로 작업을 만들고 결과를 저장한다', async (t) => {
  const { createServer } = await import('node:http')
  const runtime = await createAgentRuntime(
    {
      KEUNDAL_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test',
      KEUNDAL_MODEL: 'small',
      KEUNDAL_API_TOKEN: 'automation-test-token',
      KEUNDAL_SQLITE_PATH: sqlitePath()
    },
    { compose: createNodeComposition }
  )
  hosts.push(runtime)
  runtime.ctx.llm.countTokens = async () => 10
  runtime.ctx.llm.stream = async function* (): AsyncIterable<LLMEvent> {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'automatic response' }
    yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
  }
  const server = createServer(runtime.app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  const base = `http://127.0.0.1:${address.port}`
  const request = (method: string, path: string, body?: unknown, token = 'automation-test-token') =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  const definition = {
    label: 'Automation',
    enabled: true,
    trigger: { type: 'webhook' },
    input: { state: {}, context: [], tools: [], messages: [{ id: 'q', role: 'user', content: 'Respond' }] }
  }
  expect((await request('PUT', '/automations/hook', definition, 'wrong-token')).status).toBe(401)
  expect(
    (
      await request('PUT', '/automations/hook', {
        ...definition,
        trigger: { type: 'cron', expression: 'invalid', timezone: 'UTC' }
      })
    ).status
  ).toBe(400)
  expect((await request('PUT', '/automations/hook', definition)).status).toBe(200)
  expect((await request('POST', '/automations/hook/webhook', {})).status).toBe(400)
  expect((await request('POST', '/automations/hook/webhook', { id: 'one' }, 'wrong-token')).status).toBe(401)
  expect((await request('POST', '/automations/hook/webhook', { id: 'one', payload: { source: 'ci' } })).status).toBe(
    202
  )
  expect((await request('POST', '/automations/hook/webhook', { id: 'one' })).status).toBe(202)
  await expect.poll(async () => (await runtime.services.automation!.history('hook'))[0]?.task?.status).toBe('completed')
  const history = await (await request('GET', '/automations/hook/history')).json()
  expect(history).toMatchObject([{ status: 'submitted', task: { status: 'completed', content: 'automatic response' } }])
  expect(await runtime.services.tasks!.list()).toHaveLength(1)
  const [attempt] = await runtime.services.automation!.history('hook')
  expect((await runtime.services.session.get(attempt!.task!.threadId))?.messages).toContainEqual(
    expect.objectContaining({ role: 'assistant', content: 'automatic response' })
  )
  expect(
    (await request('PUT', '/automations/named', { ...definition, trigger: { type: 'event', name: 'ci.failed' } }))
      .status
  ).toBe(200)
  expect((await request('POST', '/automation-events', { name: 'ci.passed', id: 'build-1' })).status).toBe(202)
  expect(await runtime.services.tasks!.list()).toHaveLength(1)
  expect((await request('POST', '/automation-events', { name: 'ci.failed', id: 'build-1' })).status).toBe(202)
  await expect
    .poll(async () => (await runtime.services.automation!.history('named'))[0]?.task?.status)
    .toBe('completed')
  expect(await runtime.services.tasks!.list()).toHaveLength(2)
  expect((await request('DELETE', '/automations/hook')).status).toBe(204)
  expect((await request('POST', '/automations/hook/webhook', { id: 'two' })).status).toBe(404)
  expect(await (await request('GET', '/automations')).json()).toMatchObject([{ id: 'named' }])
})

test.each([['x'.repeat(101)], ['x'.repeat(60), 'x'.repeat(41)], [' '.repeat(1025)], ['x'.repeat(100_000)]])(
  '호스트 제목이 한도를 넘으면 스트림을 정리하고 거부한다',
  async (...chunks) => {
    const host = await createAgentHost({
      provider: 'openai',
      apiKey: 'test',
      model: 'small',
      models: { small: { contextWindow: 8000, maxOutputTokens: 1000 } },
      sqlitePath: sqlitePath()
    })
    hosts.push(host)
    let closed = false
    host.ctx.llm.stream = async function* (): AsyncIterable<LLMEvent> {
      try {
        for (const delta of chunks) yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'title', delta }
      } finally {
        closed = true
      }
    }
    await expect(
      host.services.title({ model: 'small', message: { id: 'user', role: 'user', content: '질문' } })
    ).rejects.toThrow(/title|Title/)
    expect(closed).toBe(true)
  }
)
