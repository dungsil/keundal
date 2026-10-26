import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventType, type LLMEvent } from '@keundal/core'
import { expect, onTestFinished, test, vi } from 'vitest'

import { createNodeAgentHost, createNodeComposition, createAgentRuntime } from '../src/index.js'

test.each([
  { skills: true, mcp: true },
  { skills: false, mcp: true },
  { skills: true, mcp: false },
  { skills: false, mcp: false }
])(
  '번들 선택 skills=$skills MCP=$mcp 상태를 실제 카탈로그와 프로세스에 적용하고 사용자 데이터를 보존한다',
  async (selection) => {
    const directory = mkdtempSync(join(tmpdir(), 'keundal-bundled-node-'))
    const hosts: Awaited<ReturnType<typeof createNodeAgentHost>>[] = []
    onTestFinished(async () => {
      for (const host of hosts) await host.dispose()
      rmSync(directory, { force: true, recursive: true })
    })
    const root = join(directory, 'plugin')
    const dataDirectory = join(directory, 'data')
    mkdirSync(join(root, 'skills', 'hello'), { recursive: true })
    mkdirSync(dataDirectory)
    writeFileSync(join(dataDirectory, 'keep.txt'), 'user data')
    writeFileSync(
      join(root, 'plugin.json'),
      JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'fixture' })
    )
    const skillPath = join(root, 'skills', 'hello', 'SKILL.md')
    const skill = '---\nname: hello\ndescription: Hello skill\n---\nInstructions'
    writeFileSync(skillPath, skill)
    const script = (marker: string) => `
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === 'initialize'
        ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } }] };
      console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  `
    const pluginMarker = join(directory, 'plugin-started')
    const globalMarker = join(directory, 'global-started')
    writeFileSync(
      join(root, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { fixture: { type: 'stdio', command: 'node', args: ['-e', script(pluginMarker)] } }
      })
    )
    const options = {
      provider: 'openai',
      apiKey: '',
      model: 'test',
      sqlitePath: ':memory:',
      plugins: [{ root, dataDirectory, mcp: { permissions: { fixture: { tools: ['search'] } }, timeoutMs: 3000 } }],
      mcpServers: [
        {
          serverName: 'global',
          transport: 'stdio' as const,
          command: process.execPath,
          args: ['-e', script(globalMarker)],
          permissions: { tools: ['search'] },
          timeoutMs: 3000
        }
      ],
      bundledPlugins: { '@keundal/plugin-skill': selection.skills, '@keundal/plugin-mcp-client': selection.mcp }
    }
    const host = await createNodeAgentHost(options, createNodeComposition)
    hosts.push(host)
    const catalog = await host.services.catalog!()
    expect(catalog.skills).toEqual(selection.skills ? [{ name: 'hello', description: 'Hello skill' }] : [])
    expect(catalog.tools).toHaveLength(selection.mcp ? 2 : 0)
    expect(existsSync(pluginMarker)).toBe(selection.mcp)
    expect(existsSync(globalMarker)).toBe(selection.mcp)
    expect(host.plugins).toHaveLength(1)
    expect(readFileSync(skillPath, 'utf8')).toBe(skill)
    expect(readFileSync(join(dataDirectory, 'keep.txt'), 'utf8')).toBe('user data')
    await host.dispose()
    const restored = await createNodeAgentHost({ ...options, bundledPlugins: undefined }, createNodeComposition)
    hosts.push(restored)
    expect((await restored.services.catalog!()).skills).toEqual([{ name: 'hello', description: 'Hello skill' }])
    expect((await restored.services.catalog!()).tools).toHaveLength(2)
  }
)

test('createAgentRuntime은 번들 기본 도구 선택만 전달하고 명시적 도구는 보존한다', async () => {
  const host = await createAgentRuntime(
    {
      KEUNDAL_PROVIDER: 'openai',
      KEUNDAL_MODEL: 'test',
      KEUNDAL_SQLITE_PATH: ':memory:',
      KEUNDAL_API_TOKEN: 'test-token'
    },
    {
      compose: createNodeComposition,
      bundledPlugins: { '@keundal/plugin-tool-chat': false },
      defaultTools: async () =>
        ['chart', 'weather', 'unrelated'].map((name) => ({
          name,
          description: name,
          parameters: { type: 'object' },
          execute: async () => 'ok'
        })),
      tools: [
        { name: 'operator_tool', description: 'Operator', parameters: { type: 'object' }, execute: async () => 'ok' }
      ]
    }
  )
  onTestFinished(() => host.dispose())
  expect(await host.services.catalog!()).toEqual({
    skills: [],
    tools: [
      { name: 'unrelated', description: 'unrelated' },
      { name: 'operator_tool', description: 'Operator' }
    ]
  })
})

test.each([
  { chart: false, weather: true },
  { chart: true, weather: false },
  { chart: false, weather: false },
  { chart: true, weather: true }
])('번들 chart=$chart weather=$weather 선택은 기본 도구와 명시적 모듈을 독립적으로 제어한다', async (selection) => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-split-tools-'))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const tool = (name: string) => ({
    name,
    description: name,
    parameters: { type: 'object' },
    execute: async () => 'ok'
  })
  // Resolve package-shaped fixtures from the deployment root, just like operator modules.
  for (const name of ['chart', 'weather', 'operator']) {
    const root = join(directory, 'node_modules', '@keundal', `plugin-tool-${name}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
    writeFileSync(
      join(root, 'index.js'),
      `export default () => [{ name: '${name}', description: '${name}', parameters: { type: 'object' }, execute: async () => 'ok' }]`
    )
  }
  const expected = [
    ...(selection.chart ? ['chart'] : []),
    ...(selection.weather ? ['weather'] : []),
    'operator',
    'explicit'
  ]
  for (const mode of ['array', 'provider', 'modules', 'legacy-modules'] as const) {
    const defaults = [tool('chart'), tool('weather'), tool('operator')]
    const host = await createNodeAgentHost(
      {
        provider: 'openai',
        apiKey: '',
        model: 'test',
        sqlitePath: ':memory:',
        bundledPlugins: {
          '@keundal/plugin-tool-chat': false,
          '@keundal/plugin-tool-chart': selection.chart,
          '@keundal/plugin-tool-weather': selection.weather
        },
        defaultTools: mode === 'provider' ? async () => defaults : defaults,
        tools: [tool('explicit')],
        runtimePluginBasePath: directory,
        ...(mode === 'modules' || mode === 'legacy-modules'
          ? {
              runtimePlugins: {
                plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }],
                agent: { module: 'builtin:agent' },
                tools: [
                  ...(mode === 'modules'
                    ? [{ module: '@keundal/plugin-tool-chart' }, { module: '@keundal/plugin-tool-weather' }]
                    : [{ module: '@keundal/plugin-tool-chat' }]),
                  { module: '@keundal/plugin-tool-operator' }
                ]
              }
            }
          : {})
      },
      createNodeComposition
    )
    onTestFinished(() => host.dispose())
    expect((await host.services.catalog!()).tools.map(({ name }) => name)).toEqual(expected)
    await host.dispose()
  }
})

test('스킬을 끄면 명시적 builtin:skills 매니페스트와 Agent Plugins가 충돌하지 않는다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-disabled-skills-'))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(
    join(directory, 'plugin.json'),
    JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'fixture' })
  )
  const host = await createNodeAgentHost(
    {
      provider: 'openai',
      apiKey: '',
      model: 'test',
      sqlitePath: ':memory:',
      plugins: [{ root: directory, dataDirectory: join(directory, 'data') }],
      bundledPlugins: { '@keundal/plugin-skill': false },
      runtimePlugins: {
        plugins: [{ module: 'builtin:llm' }, { module: 'builtin:store' }, { module: 'builtin:skills' }],
        agent: { module: 'builtin:agent', config: { skills: true } }
      }
    },
    createNodeComposition
  )
  onTestFinished(() => host.dispose())
  expect(await host.services.catalog!()).toEqual({ skills: [], tools: [] })
  expect(host.ctx.skills).toBeUndefined()
  const count = vi.spyOn(host.ctx.llm, 'countTokens').mockResolvedValue(10)
  const stream = vi
    .spyOn(host.ctx.llm, 'stream')
    .mockImplementation(async function* (request): AsyncIterable<LLMEvent> {
      expect(request.input.tools.some((tool) => tool.name === 'skill')).toBe(false)
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'ok' }
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
    })
  onTestFinished(() => {
    count.mockRestore()
    stream.mockRestore()
  })
  const events = []
  for await (const event of host.services.run({
    threadId: 'no-skills',
    runId: 'no-skills-run',
    state: {},
    context: [],
    tools: [],
    messages: [{ id: 'user', role: 'user', content: 'hello' }]
  }))
    events.push(event)
  expect(events.at(-1)?.type).toBe('RUN_FINISHED')
  expect(stream).toHaveBeenCalledTimes(1)
})
