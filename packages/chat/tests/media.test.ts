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

test('비디오 주소에는 인증 토큰 대신 항목 전용 티켓만 담는다', async () => {
  const { calls, request } = recorder(() => json({ ticket: 'read/ticket' }))
  const client = createHttpMediaClient({ connection, request })
  await expect(client.videoUrl({ libraryPath: '/data/lib', itemId: 'item-1' })).resolves.toBe(
    'http://127.0.0.1:8080/media/video?libraryPath=%2Fdata%2Flib&itemId=item-1&ticket=read%2Fticket'
  )
  expect(calls[0]!.url).toBe('http://127.0.0.1:8080/media/video-access')
  expect(calls[0]!.init.method).toBe('POST')
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ libraryPath: '/data/lib', itemId: 'item-1' })
  expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer token-1')
})

test('인증된 상태 응답이 명시적으로 사용 가능할 때만 기능을 제공한다', async () => {
  for (const [body, status, expected] of [
    [{ available: true }, 200, true],
    [{ available: false }, 200, false],
    [{}, 200, false],
    [{ available: true }, 401, false],
    [{}, 404, false],
    [{}, 503, false]
  ] as const) {
    const { calls, request } = recorder(() => json(body, status))
    await expect(createHttpMediaClient({ connection, request }).available()).resolves.toBe(expected)
    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/media/status')
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer token-1')
  }
  await expect(
    createHttpMediaClient({
      connection: async () => {
        throw new Error('offline')
      }
    }).available()
  ).resolves.toBe(false)
})

test('재시작 후 호출은 변경된 주소와 인증을 다시 구하고 기능 상태를 캐시하지 않는다', async () => {
  let revision = 0
  const { calls, request } = recorder(() => json({ available: revision === 2 }))
  const client = createHttpMediaClient({
    request,
    connection: async () => ({ endpoint: `http://localhost:${++revision}`, token: `token-${revision}` })
  })
  await expect(client.available()).resolves.toBe(false)
  await expect(client.available()).resolves.toBe(true)
  expect(calls.map((call) => call.url)).toEqual(['http://localhost:1/media/status', 'http://localhost:2/media/status'])
  expect(new Headers(calls[1]!.init.headers).get('authorization')).toBe('Bearer token-2')
})

test('다운로드 제어 요청은 작업 식별자를 인코딩하고 동작을 전달한다', async () => {
  const { calls, request } = recorder(() => new Response(null, { status: 204 }))
  const client = createHttpMediaClient({ connection, request })
  for (const action of ['pause', 'resume', 'cancel'] as const) await client.controlDownload('job/1', action)
  expect(calls.map((call) => call.url)).toEqual(
    ['pause', 'resume', 'cancel'].map((action) => `http://127.0.0.1:8080/media/downloads/job%2F1/${action}`)
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
