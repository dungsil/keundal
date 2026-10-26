import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { Parser } from 'htmlparser2'
import { expect, onTestFinished, test } from 'vitest'

test('프로덕션 서버는 경로와 압축된 CSS를 제공하고 언어와 리다이렉트를 유지한다', async () => {
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  await new Promise<void>(resolve => listener.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('No preview port')
  const server = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(address.port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  onTestFinished(async () => {
    if (server.exitCode !== null || server.signalCode !== null) return
    const exited = once(server, 'exit')
    server.kill()
    await exited
  })
  const origin = await new Promise<string>((resolve, reject) => {
    let output = ''
    server.once('error', reject)
    server.once('exit', code => reject(new Error(`Preview exited (${code}): ${output}`)))
    server.stderr.on('data', (data) => {
      output += data
    })
    server.stdout.on('data', (data) => {
      output += data
      const url = /Listening on (http:\/\/[^\s]+)/.exec(output)?.[1]
      if (url) resolve(url)
    })
  })
  const stylesheets = new Set<string>()
  for (const path of ['/', '/chat/preview-smoke-test', '/settings', '/settings/appearance', '/settings/models', '/settings/llm', '/settings/mcp', '/settings/skills']) {
    const response = await fetch(new URL(path, origin))
    const html = await response.text()
    expect(response.status, html).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('id="__nuxt"')
    expect(html.match(/<button\b[^>]*aria-label="Skills"/), path).toBeNull()
    expect(html.match(/<a\b[^>]*aria-label="Settings"/), path).not.toBeNull()
    const linked: string[] = []
    new Parser({
      onopentag(name, attributes) {
        if (name === 'link' && attributes.rel === 'stylesheet' && attributes.href) linked.push(attributes.href)
      }
    }).end(html)
    expect(linked.length, path).toBeGreaterThan(0)
    for (const href of linked) stylesheets.add(href)
  }
  for (const href of stylesheets) {
    const response = await fetch(new URL(href, origin), { headers: { 'accept-encoding': 'br' } })
    expect(response.status, href).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/css')
    expect(response.headers.get('content-encoding')).toBe('br')
    expect(response.headers.get('cache-control')).toMatch(/max-age=[1-9]\d*/)
    expect(await response.text()).not.toBe('')
  }
  const localizedRequests: { headers: Record<string, string>, language: string, label: string }[] = [
    { headers: { 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8' }, language: 'ko', label: '새 대화' },
    { headers: { 'accept-language': 'ko-KR', 'cookie': 'keundal-locale=en' }, language: 'en', label: 'New chat' },
    { headers: { 'accept-language': 'en-US', 'cookie': 'keundal-locale=ko' }, language: 'ko', label: '새 대화' },
    { headers: { 'accept-language': 'fr-FR', 'cookie': 'keundal-locale=invalid' }, language: 'en', label: 'New chat' }
  ]
  await Promise.all(localizedRequests.map(async ({ headers, language, label }) => {
    const response = await fetch(origin, { headers })
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain(`lang="${language}"`)
    expect(html).toContain(label)
    expect(html).not.toContain(`aria-label="${language === 'ko' ? '스킬' : 'Skills'}"`)
    expect(html).toContain(`aria-label="${language === 'ko' ? '설정' : 'Settings'}"`)
    const settings = await fetch(new URL('/settings', origin), { headers })
    const settingsHtml = await settings.text()
    expect(settings.status).toBe(200)
    expect(settingsHtml).toContain(`lang="${language}"`)
    expect(settingsHtml).toContain(language === 'ko' ? '대화로 돌아가기' : 'Back to chat')
    expect(settingsHtml).toContain('id="appearance-settings-title"')
    expect(new URL(settings.url).pathname).toBe('/settings/appearance')
    expect(settingsHtml).not.toContain('id="llm-settings-title"')
    const llm = await fetch(new URL('/settings/llm', origin), { headers })
    expect(await llm.text()).toContain('id="llm-settings-title"')
    const mcp = await fetch(new URL('/settings/mcp', origin), { headers })
    expect(await mcp.text()).toContain('id="mcp-settings-title"')
    const skills = await fetch(new URL('/settings/skills', origin), { headers })
    expect(await skills.text()).toContain('id="skill-settings-title"')
  }))
  for (const [query, target] of [
    ['section=appearance', 'appearance'],
    ['section=skills', 'skills'],
    ['section=mcp', 'mcp'],
    ['provider=openai', 'llm'],
    ['section=invalid', 'appearance']
  ] as const) {
    const response = await fetch(new URL(`/settings?${query}&returnTo=/chat/preview-smoke-test`, origin), { redirect: 'manual' })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!, origin)
    expect(location.pathname).toBe(`/settings/${target}`)
    expect(location.searchParams.get('returnTo')).toBe('/chat/preview-smoke-test')
    expect(location.searchParams.has('section')).toBe(false)
    if (query.includes('provider=')) expect(location.searchParams.get('provider')).toBe('openai')
  }
  const missing = await fetch(new URL('/missing-localized-page', origin), { headers: { 'accept': 'text/html', 'accept-language': 'ko-KR' } })
  expect(missing.status).toBe(404)
  expect(await missing.text()).toContain('페이지를 찾을 수 없습니다')
  for (const path of ['/auth/github', '/api/_auth/session']) {
    const response = await fetch(new URL(path, origin), { redirect: 'manual' })
    expect(response.status).toBe(404)
    expect(response.headers.get('set-cookie')).toBeNull()
  }
}, 15_000)
