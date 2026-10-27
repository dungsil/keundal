import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentRuntime, createNodeComposition, type AgentRuntime } from '@keundal/agent-runtime-node'
import { expect, test, type TestContext } from 'vitest'

const token = 'media-runtime-token'

const llmPlugin = `export default ctx => {
  ctx.provide('llm', {
    async getModel() { return { contextWindow: 128000, maxOutputTokens: 4096 } },
    async countTokens() { return 10 },
    async *stream() {
      yield { type: 'TEXT_MESSAGE_START', messageId: 'answer', role: 'assistant' }
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'done' }
      yield { type: 'TEXT_MESSAGE_END', messageId: 'answer' }
    }
  })
}`

interface Fixture {
  readonly directory: string
  readonly libraryRoot: string
  readonly mediaDirectory: string
  readonly manifest: string
}

function fixture(t: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'keundal-media-runtime-'))
  const plugins = join(directory, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'llm.mjs'), llmPlugin)
  const manifest = join(directory, 'keundal.plugins.json')
  writeFileSync(
    manifest,
    JSON.stringify({
      plugins: [
        { module: './plugins/llm.mjs' },
        { module: 'builtin:store', config: { path: join(directory, 'store.sqlite') } }
      ],
      agent: { module: 'builtin:agent', config: { subagents: false } }
    })
  )
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    manifest,
    libraryRoot: join(directory, 'libraries'),
    mediaDirectory: join(directory, 'media')
  }
}

async function serve(t: TestContext, runtime: AgentRuntime) {
  const server = createServer(runtime.app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a port')
  t.onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await runtime.dispose()
  })
  const base = `http://127.0.0.1:${address.port}`
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  }
}

test('미디어 디렉터리를 설정하면 호스트가 자료库·도구·다운로드 서비스를 조립한다', async (t) => {
  const files = fixture(t)
  const runtime = await createAgentRuntime(
    {
      KEUNDAL_PROVIDER: 'external-provider',
      KEUNDAL_MODEL: 'test-model',
      KEUNDAL_API_TOKEN: token,
      KEUNDAL_PLUGIN_CONFIG: files.manifest,
      KEUNDAL_MEDIA_DIR: files.mediaDirectory,
      KEUNDAL_LIBRARY_DIR: files.libraryRoot
    },
    { compose: createNodeComposition }
  )
  expect(runtime.services.media).toBeDefined()
  expect(runtime.services.media?.transcription).toBeDefined()
  expect(runtime.services.media?.translation).toBeDefined()
  expect(runtime.services.media?.export).toBeDefined()
  const call = await serve(t, runtime)
  const tools = await call('GET', '/media/tools')
  expect(tools.status).toBe(200)
  expect((tools.json.tools as { name: string }[]).map((tool) => tool.name)).toEqual(['yt-dlp', 'ffmpeg'])
  const created = await call('POST', '/media/libraries', { path: join(files.libraryRoot, 'one') })
  expect(created.status).toBe(201)
  const listed = await call('GET', `/media/libraries/items?path=${encodeURIComponent(join(files.libraryRoot, 'one'))}`)
  expect(listed.status).toBe(200)
  expect(listed.json.items).toEqual([])
})

test('자료库 경로가 지정한 상위 디렉터리 밖이면 요청을 거부한다', async (t) => {
  const files = fixture(t)
  const runtime = await createAgentRuntime(
    {
      KEUNDAL_PROVIDER: 'external-provider',
      KEUNDAL_MODEL: 'test-model',
      KEUNDAL_API_TOKEN: token,
      KEUNDAL_PLUGIN_CONFIG: files.manifest,
      KEUNDAL_MEDIA_DIR: files.mediaDirectory,
      KEUNDAL_LIBRARY_DIR: files.libraryRoot
    },
    { compose: createNodeComposition }
  )
  const call = await serve(t, runtime)
  const outside = await call('POST', '/media/libraries', { path: join(files.directory, 'outside') })
  expect(outside.status).toBe(400)
  expect(String(outside.json.error)).toBe('media-invalid-request')
})

test('미디어 디렉터리가 없으면 미디어 서비스를 조립하지 않고 503으로 응답한다', async (t) => {
  const files = fixture(t)
  const runtime = await createAgentRuntime(
    {
      KEUNDAL_PROVIDER: 'external-provider',
      KEUNDAL_MODEL: 'test-model',
      KEUNDAL_API_TOKEN: token,
      KEUNDAL_PLUGIN_CONFIG: files.manifest
    },
    { compose: createNodeComposition }
  )
  expect(runtime.services.media).toBeUndefined()
  const call = await serve(t, runtime)
  const result = await call('GET', '/media/tools')
  expect(result.status).toBe(503)
})
