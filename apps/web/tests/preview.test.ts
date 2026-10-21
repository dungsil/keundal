import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { runInNewContext } from 'node:vm'
import { DomUtils, parseDocument } from 'htmlparser2'
import { expect, onTestFinished, test } from 'vitest'
import { translate } from '../../../packages/ui/app/utils/locale'

function readHeadScripts(html: string) {
  const document = parseDocument(html)
  const head = DomUtils.findOne(node => node.name === 'head', document.children)
  return head
    ? DomUtils.findAll(node => node.name === 'script', head.children).map(node => DomUtils.textContent(node))
    : []
}

test.each([
  { name: '일반 태그', start: 'script', end: 'script', attributes: '' },
  { name: '대문자 태그', start: 'SCRIPT', end: 'SCRIPT', attributes: '' },
  { name: '닫는 태그의 공백', start: 'script', end: 'script ', attributes: '' },
  { name: '혼합 대소문자와 줄바꿈', start: 'ScRiPt', end: 'sCrIpT\t\n ', attributes: '' },
  { name: '속성 안의 꺾쇠', start: 'script', end: 'script', attributes: ' data-note=">"' }
])('$name: head의 스크립트 내용을 정확히 읽는다', ({ start, end, attributes }) => {
  const source = 'document.documentElement.dataset.greetingTime = "morning"'
  const html = `<head><${start}${attributes}>${source}</${end}></head><body><script>ignore</script></body>`
  expect(readHeadScripts(html)).toEqual([source])
})

test('프로덕션 서버는 홈과 대화 경로를 모듈 로드 오류 없이 렌더링한다', async () => {
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
  for (const path of ['/', '/chat/preview-smoke-test', '/settings']) {
    const response = await fetch(new URL(path, origin))
    const html = await response.text()
    expect(response.status, html).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('id="__nuxt"')
    if (path === '/') {
      const script = readHeadScripts(html)
        .find(content => content?.includes('dataset.greetingTime'))
      expect(script, '앱 스크립트 실행 전에 인사말을 선택해야 한다').toBeDefined()
      for (const [hour, period] of [[0, 'morning'], [11, 'morning'], [12, 'afternoon'], [17, 'afternoon'], [18, 'evening'], [23, 'evening']] as const) {
        const dataset: Record<string, string> = {}
        runInNewContext(script!, {
          document: { documentElement: { dataset } },
          Date: class { getHours() { return hour } }
        })
        expect(dataset.greetingTime, `${hour}시`).toBe(period)
      }
    }
    expect(html.match(/<button\b[^>]*aria-label="Skills"/), path).not.toBeNull()
    expect(html.match(/<a\b[^>]*aria-label="Settings"/), path).not.toBeNull()
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
    const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1]
    expect(heading).toBeDefined()
    for (const period of ['morning', 'afternoon', 'evening'] as const) {
      expect(heading).toContain(`data-greeting="${period}"`)
      expect(heading).toContain(translate(language === 'ko' ? 'ko' : 'en', `greeting.${period}`))
    }
    expect(html).toContain(`aria-label="${language === 'ko' ? '스킬' : 'Skills'}"`)
    expect(html).toContain(`aria-label="${language === 'ko' ? '설정' : 'Settings'}"`)
    const settings = await fetch(new URL('/settings', origin), { headers })
    const settingsHtml = await settings.text()
    expect(settings.status).toBe(200)
    expect(settingsHtml).toContain(`lang="${language}"`)
    expect(settingsHtml).toContain(language === 'ko' ? '대화로 돌아가기' : 'Back to chat')
  }))
  const missing = await fetch(new URL('/missing-localized-page', origin), { headers: { 'accept': 'text/html', 'accept-language': 'ko-KR' } })
  expect(missing.status).toBe(404)
  expect(await missing.text()).toContain('페이지를 찾을 수 없습니다')
  for (const path of ['/auth/github', '/api/_auth/session']) {
    const response = await fetch(new URL(path, origin), { redirect: 'manual' })
    expect(response.status).toBe(404)
    expect(response.headers.get('set-cookie')).toBeNull()
  }
}, 15_000)
