import { createHttpMediaClient } from '@keundal/chat/media'
import { expect, test } from 'vitest'

const connection = async () => ({ endpoint: 'http://127.0.0.1:8080/', token: 'token-1' })

function recorder(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const request = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof globalThis.fetch
  return { calls, request }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('호스트의 미디어 경로를 인증 헤더와 함께 호출한다', async () => {
  const { calls, request } = recorder(() => json({ tools: [{ name: 'yt-dlp', installed: false }] }))
  const client = createHttpMediaClient({ connection, request })
  const tools = await client.tools()
  expect(tools).toHaveLength(1)
  expect(calls[0]!.url).toBe('http://127.0.0.1:8080/media/tools')
  expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer token-1')
})

test('본문이 있는 요청은 JSON으로 직렬화한다', async () => {
  const { calls, request } = recorder(() => json({ job: { jobId: 'j1' } }, 202))
  const client = createHttpMediaClient({ connection, request })
  const job = await client.startDownload({ url: 'https://example.com/a', outputDirectory: '/inbox' })
  expect(job).toEqual({ jobId: 'j1' })
  expect(calls[0]!.init.method).toBe('POST')
  expect(calls[0]!.init.body).toBe(JSON.stringify({ url: 'https://example.com/a', outputDirectory: '/inbox' }))
  expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/json')
})

test('204 응답은 본문 없이 끝난다', async () => {
  const { request } = recorder(() => new Response(null, { status: 204 }))
  const client = createHttpMediaClient({ connection, request })
  await expect(client.configureTool('ffmpeg', null)).resolves.toBeUndefined()
})

test('호스트가 돌려준 실패 사유를 예외 메시지로 전달한다', async () => {
  const { request } = recorder(() => json({ error: 'media is not configured' }, 503))
  const client = createHttpMediaClient({ connection, request })
  await expect(client.tools()).rejects.toThrow('media is not configured')
})

test('자료库 경로는 쿼리 값으로 인코딩한다', async () => {
  const { calls, request } = recorder(() => json({ items: [] }))
  const client = createHttpMediaClient({ connection, request })
  await client.items('/data/내 자료库')
  expect(calls[0]!.url).toBe(
    `http://127.0.0.1:8080/media/libraries/items?path=${encodeURIComponent('/data/내 자료库')}`
  )
})

test('비디오 주소는 토큰을 쿼리에 담아 돌려준다', async () => {
  const { request } = recorder(() => json({}))
  const client = createHttpMediaClient({ connection, request })
  await expect(client.videoUrl({ libraryPath: '/data/lib', itemId: 'item-1' })).resolves.toBe(
    'http://127.0.0.1:8080/media/video?libraryPath=%2Fdata%2Flib&itemId=item-1&token=token-1'
  )
})

test('클립 내보내기와 FCPXML 요청을 호스트 경로로 보낸다', async () => {
  const { calls, request } = recorder((url) =>
    url.endsWith('/fcpxml')
      ? json({ export: { path: '/out/clips.fcpxml', clipCount: 1 } })
      : json({ files: [{ clipId: 'c1', name: '하나', path: '/out/하나.mp4' }] })
  )
  const client = createHttpMediaClient({ connection, request })
  const clips = [{ id: 'c1', name: '하나', startMs: 0, endMs: 1_000 }]
  const files = await client.exportClips({
    libraryPath: '/lib',
    itemId: 'item-1',
    outputDirectory: '/out',
    clips
  })
  expect(files[0]!.path).toBe('/out/하나.mp4')
  const written = await client.exportFcpxml({
    libraryPath: '/lib',
    itemId: 'item-1',
    outputPath: '/out/clips.fcpxml',
    clips
  })
  expect(written.clipCount).toBe(1)
  expect(calls.map((entry) => entry.url)).toEqual([
    'http://127.0.0.1:8080/media/exports/clips',
    'http://127.0.0.1:8080/media/exports/fcpxml'
  ])
})
