import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadAgentPlugin, PLUGIN_SCHEMA, MCP_SCHEMA, type LoadedAgentPlugin } from '@keundal/agent-plugins'
import { expect, test, type TestContext } from 'vitest'

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'agent-plugins-'))
  const root = join(base, 'plugin')
  const dataDirectory = join(base, 'data')
  const plugins: LoadedAgentPlugin[] = []
  t.onTestFinished(async () => {
    await Promise.all(plugins.map((p) => p.close()))
    await rm(base, { recursive: true, force: true })
  })
  const file = async (path: string, value: unknown) => {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value))
  }
  await file('plugin.json', { $schema: PLUGIN_SCHEMA, name: 'test.plugin' })
  const skill = (name = 'hello', content = 'Instructions') =>
    file(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: A skill\n---\n${content}`)
  const load = async (mcp = false) => {
    const p = await loadAgentPlugin({
      root,
      dataDirectory,
      ...(mcp ? { mcp: { permissions: { good: { tools: '*' } }, timeoutMs: 2000 } } : {})
    })
    plugins.push(p)
    return p
  }
  const mcp = (servers: unknown) => file('mcp.json', { $schema: MCP_SCHEMA, mcpServers: servers })
  return { base, root, dataDirectory, file, skill, load, mcp }
}
const stdio = { type: 'stdio', command: 'node', args: [fileURLToPath(new URL('./stdio.ts', import.meta.url))] }

test('최소 매니페스트는 구성요소 없이 로드한다', async (t) => {
  const f = await fixture(t)
  const p = await f.load()
  expect(p.manifest.name).toBe('test.plugin')
  expect((await p.skillProvider.prepare()).skills).toEqual([])
  expect(await p.tools()).toEqual([])
  expect(p.diagnostics).toEqual([])
})

test('알 수 없는 필드와 확장 값은 실행하지 않고 보고하거나 무시한다', async (t) => {
  const f = await fixture(t)
  await f.file('plugin.json', {
    $schema: PLUGIN_SCHEMA,
    name: 'test',
    version: 'not-semver',
    homepage: 'not-url',
    alien: {},
    extensions: { 'com.unknown': 42 }
  })
  const p = await f.load()
  expect(p.manifest).not.toHaveProperty('alien')
  expect(p.diagnostics).toEqual([{ component: 'manifest', entry: 'alien', message: 'unknown field ignored' }])
  await f.file('plugin.json', { $schema: PLUGIN_SCHEMA, name: 'test', extensions: [] })
  expect((await f.load()).diagnostics[0]?.message).toContain('extensions')
})

test.for([
  [],
  {},
  { $schema: PLUGIN_SCHEMA, name: 'Bad' },
  { $schema: PLUGIN_SCHEMA, name: 'a--b' },
  { $schema: PLUGIN_SCHEMA, name: 'a..b' },
  { $schema: PLUGIN_SCHEMA, name: 'a'.repeat(65) },
  { $schema: 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json', name: 'test' },
  { $schema: PLUGIN_SCHEMA, name: 'test', author: { extra: '' } },
  { $schema: PLUGIN_SCHEMA, name: 'test', keywords: [1] },
  { $schema: PLUGIN_SCHEMA, name: 'test', version: 1 }
])('잘못된 매니페스트는 구성요소 탐색 전에 거부한다: %j', async (value, t) => {
  const f = await fixture(t)
  await f.file('plugin.json', value)
  await expect(f.load()).rejects.toThrow()
})

test('잘못된 스킬과 중첩된 스킬을 건너뛰고 유효한 스킬을 읽는다', async (t) => {
  const f = await fixture(t)
  await f.skill()
  await f.file('skills/broken/SKILL.md', 'invalid')
  await f.file('skills/mismatch/SKILL.md', '---\nname: other\ndescription: test\n---\nbody')
  await f.file('skills/nested/deeper/SKILL.md', '---\nname: deeper\ndescription: test\n---')
  const p = await f.load()
  const catalog = await p.skillProvider.prepare()
  expect(catalog.skills.map((s) => s.name)).toEqual(['hello'])
  expect((await catalog.load('hello'))?.content).toContain('Instructions')
  expect(await catalog.load('missing')).toBeUndefined()
  expect(p.diagnostics.some((d) => d.entry === 'broken')).toBe(true)
})

test('빈 본문과 유니코드 이름을 가진 유효한 스킬도 제공한다', async (t) => {
  const f = await fixture(t)
  await f.skill('분석', '')
  const catalog = await (await f.load()).skillProvider.prepare()
  expect(catalog.skills).toHaveLength(1)
  expect((await catalog.load(catalog.skills[0]!.name))?.content).toContain('name: 분석')
})

test('루트 밖의 매니페스트 링크는 거부한다', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.base, 'outside.json'), await readFile(join(f.root, 'plugin.json')))
  await rm(join(f.root, 'plugin.json'))
  await symlink(join(f.base, 'outside.json'), join(f.root, 'plugin.json'))
  await expect(f.load()).rejects.toThrow('boundary')
})

test('스킬 링크는 내부 대상만 허용하고 로드 직전 경계를 다시 검사한다', async (t) => {
  const f = await fixture(t)
  await f.file('bundled/SKILL.md', '---\nname: hello\ndescription: test\n---\nbody')
  await mkdir(join(f.root, 'skills'))
  await symlink('../bundled', join(f.root, 'skills/hello'))
  const catalog = await (await f.load()).skillProvider.prepare()
  expect(catalog.skills).toHaveLength(1)
  await rm(join(f.root, 'bundled/SKILL.md'))
  await writeFile(join(f.base, 'outside.md'), 'secret')
  await symlink(join(f.base, 'outside.md'), join(f.root, 'bundled/SKILL.md'))
  await expect(catalog.load('hello')).rejects.toThrow('boundary')
})

test.for(['skills', 'mcp.json'])('외부 구성요소 링크 %s는 해당 종류만 비활성화한다', async (component, t) => {
  const f = await fixture(t)
  if (component === 'mcp.json') await f.skill()
  const outside = join(f.base, 'outside')
  if (component === 'skills') await mkdir(outside)
  else await writeFile(outside, '{}')
  await symlink(outside, join(f.root, component))
  const p = await f.load(true)
  expect(p.diagnostics.some((d) => d.message.includes('boundary'))).toBe(true)
  if (component === 'mcp.json') expect((await p.skillProvider.prepare()).skills).toHaveLength(1)
})

test('MCP 설정 오류가 있어도 스킬은 로드한다', async (t) => {
  const f = await fixture(t)
  await f.skill()
  await f.file('mcp.json', { $schema: PLUGIN_SCHEMA, mcpServers: {} })
  const p = await f.load(true)
  expect(p.diagnostics[0]?.component).toBe('mcp')
  expect((await p.skillProvider.prepare()).skills).toHaveLength(1)
})

test('서버별 검증과 연결 실패를 분리하고 stdio 환경과 인자를 한 번만 치환한다', async (t) => {
  const f = await fixture(t)
  await f.mcp({
    bad: { type: 'stdio', command: '../escape' },
    missing: { type: 'stdio', command: 'keundal-nonexistent-executable' },
    reserved: { ...stdio, env: { PLUGIN_ROOT: 'bad' } },
    escape: { ...stdio, cwd: './..' },
    unsupported: { type: 'sse', url: 'https://example.com/mcp' },
    unknown: { ...stdio, unexpected: true },
    good: {
      ...stdio,
      args: [...stdio.args, '${PLUGIN_ROOT}', '${PLUGIN_DATA}', '${HOME}', '../opaque'],
      env: { VALUE: '${PLUGIN_ROOT}:${PLUGIN_DATA}:${HOME}' }
    }
  })
  const p = await f.load(true)
  expect(p.diagnostics.filter((d) => d.component === 'mcp')).toHaveLength(6)
  const tools = await p.tools()
  expect(tools).toHaveLength(1)
  const result = JSON.parse(
    await tools[0]!.execute({}, { threadId: 't', runId: 'r', toolCallId: 'c', signal: new AbortController().signal })
  )
  const value = JSON.parse(result.content[0].text)
  expect(value).toMatchObject({
    root: f.root,
    data: f.dataDirectory,
    cwd: f.root,
    args: [f.root, f.dataDirectory, '${HOME}', '../opaque'],
    value: `${f.root}:${f.dataDirectory}:` + '${HOME}'
  })
  await writeFile(join(f.dataDirectory, 'persistent'), 'state')
  await p.close()
  await p.close()
  expect(await readFile(join(f.dataDirectory, 'persistent'), 'utf8')).toBe('state')
  await expect(p.tools()).rejects.toThrow('closed')
  await expect(p.skillProvider.prepare()).rejects.toThrow('closed')
  expect(() => process.kill(value.pid, 0)).toThrow()
})

test.for([
  { type: 'streamable-http', url: 'http://example.com/mcp' },
  { type: 'streamable-http', url: 'https://user:pass@example.com/mcp' },
  { type: 'streamable-http', url: 'https://example.com/mcp#fragment' },
  { type: 'streamable-http', url: 'https://example.com', headers: { A: '1', a: '2' } },
  { type: 'streamable-http', url: 'https://example.com', headers: { A: 'bad\r\nvalue' } },
  { type: 'streamable-http', url: 'https://example.com', command: 'node' }
])('원격 서버의 잘못된 URL이나 헤더를 연결 전에 거부한다: %j', async (server, t) => {
  const f = await fixture(t)
  await f.mcp({ invalid: server })
  const p = await f.load(true)
  expect(p.diagnostics).toHaveLength(1)
  expect(p.diagnostics[0]?.entry).toBe('invalid')
  expect(await p.tools()).toEqual([])
})

test('MCP는 명시적으로 활성화하지 않으면 실행하지 않는다', async (t) => {
  const f = await fixture(t)
  await f.mcp({ good: stdio })
  expect(await (await f.load()).tools()).toEqual([])
})

test('이미 취소된 로딩은 파일을 읽거나 서버를 시작하지 않는다', async () => {
  await expect(
    loadAgentPlugin(
      { root: '/missing', dataDirectory: '/missing' },
      { signal: AbortSignal.abort(new Error('cancelled')) }
    )
  ).rejects.toThrow('cancelled')
})

test('HTTP 리디렉션으로 다른 출처에 구성된 헤더를 보내지 않는다', async (t) => {
  const { createServer } = await import('node:http')
  let forwarded = false
  const target = createServer((_req, res) => {
    forwarded = true
    res.end()
  })
  const source = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as { port: number }).port}/mcp` }).end()
  })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(() => {
    source.closeAllConnections()
    source.close()
    target.closeAllConnections()
    target.close()
  })
  const f = await fixture(t)
  await f.mcp({
    good: {
      type: 'streamable-http',
      url: `http://127.0.0.1:${(source.address() as { port: number }).port}/mcp`,
      headers: { 'X-Tenant': 'public' }
    }
  })
  const p = await f.load(true)
  expect(p.diagnostics.some((d) => d.entry === 'good')).toBe(true)
  expect(forwarded).toBe(false)
})

test('서버별 cwd 경계와 일회성 치환을 실제 프로세스에서 적용한다', async (t) => {
  const f = await fixture(t)
  const root = join(f.base, 'plugin-${PLUGIN_DATA}')
  const { rename } = await import('node:fs/promises')
  await rename(f.root, root)
  await mkdir(join(f.dataDirectory, 'work'), { recursive: true })
  await writeFile(
    join(root, 'mcp.json'),
    JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        good: { ...stdio, env: { VALUE: '${PLUGIN_ROOT}' }, cwd: '${PLUGIN_DATA}/work' },
        escape: { ...stdio, cwd: '${PLUGIN_DATA}/..' }
      }
    })
  )
  const p = await loadAgentPlugin({
    root,
    dataDirectory: f.dataDirectory,
    mcp: { permissions: { good: { tools: '*' } } }
  })
  try {
    const tools = await p.tools()
    const result = JSON.parse(
      await tools[0]!.execute({}, { threadId: 't', runId: 'r', toolCallId: 'c', signal: new AbortController().signal })
    )
    expect(JSON.parse(result.content[0].text)).toMatchObject({ value: root, cwd: join(f.dataDirectory, 'work') })
    expect(p.diagnostics.some((d) => d.entry === 'escape')).toBe(true)
  } finally {
    await p.close()
  }
})
