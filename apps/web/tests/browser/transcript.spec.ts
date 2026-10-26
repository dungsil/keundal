import { readFile } from 'node:fs/promises'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { test, expect, ready, accessible } from './fixtures'

async function seedChat(page: import('@playwright/test').Page, content?: ChatMessage[]) {
  await ready(page, '/')
  await page.evaluate(async (content) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open('keundal-web', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const messages = content ?? Array.from({ length: 85 }, (_, index) => ({
      id: `fixture-message-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      parts: [{ type: 'text', text: `Fixture message ${index}` }]
    }))
    const chat = {
      id: 'browser-fixture', title: 'Browser fixture', createdAt: '2026-01-01T00:00:00.000Z',
      messages, votes: [], model: 'openai/gpt-5-nano', started: true, isOwner: true, visibility: 'private'
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('threads', 'readwrite')
      transaction.objectStore('threads').put({ threadId: chat.id, revision: 1, messages: [], state: { web: chat } })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  }, content)
}

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
})

test('긴 대화는 최근 메시지부터 표시하고 이전 메시지를 추가로 표시한다 @a11y:transcript', async ({ page }) => {
  await seedChat(page)
  await ready(page, '/chat/browser-fixture')
  await expect(page.locator('[data-message-link]')).toHaveCount(40)
  await expect(page.locator('#message-fixture-message-0')).toHaveCount(0)
  await accessible(page)
  await page.getByRole('button', { name: /Load older messages/ }).click()
  await expect(page.locator('[data-message-link]')).toHaveCount(80)
})

test('이전 메시지 링크를 열면 대상 메시지를 표시하고 전체 대화를 내보낸다', async ({ page }) => {
  await seedChat(page)
  await ready(page, '/chat/browser-fixture#message-fixture-message-0')
  await expect(page.locator('#message-fixture-message-0')).toBeVisible()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export as Markdown' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/\.md$/)
  const content = await readFile((await download.path())!, 'utf8')
  expect(content).toContain('Fixture message 0')
  expect(content).toContain('Fixture message 84')
})

test('일반 응답은 원문으로 표시하고 markdown 도구만 서식을 적용하며 재접속과 복사·내보내기에 보존한다', async ({ page, context, browserName }) => {
  const plain = '**Plain text**\n# Not a heading\n<img src=x onerror="alert(1)">'
  const markdown = '## Formatted report\n\n**Markdown content**\n\n| Item | Total |\n| --- | --- |\n| A | 37 |\n\n```js\nconst total = 37\n```\n\n![picture](https://example.com/a.png)'
  await seedChat(page, [{
    id: 'formats', role: 'assistant', parts: [
      { type: 'text', text: plain },
      { type: 'source-url', sourceId: 'source', url: 'https://example.com/report', title: 'Report source' },
      { type: 'source-url', sourceId: 'unsafe', url: 'javascript:alert(1)', title: 'Unsafe source' },
      { type: 'tool-markdown', toolCallId: 'formatted', state: 'output-available', input: { content: markdown }, output: { displayed: true } }
    ]
  }])
  for (let visit = 0; visit < 2; visit++) {
    await ready(page, '/chat/browser-fixture')
    const message = page.locator('#message-formats')
    await expect(message.getByText(plain, { exact: true })).toBeVisible()
    await expect(message.getByRole('heading', { name: 'Not a heading' })).toHaveCount(0)
    await expect(message.getByRole('heading', { name: 'Formatted report' })).toBeVisible()
    await expect(message.locator('strong')).toHaveText('Markdown content')
    await expect(message.getByRole('cell', { name: '37', exact: true })).toBeVisible()
    await expect(message.locator('pre')).toContainText('const total = 37')
    await expect(message.locator('pre .shiki, pre.shiki')).toHaveCount(1)
    await expect(message.locator('img, script')).toHaveCount(0)
    await expect(message.getByRole('link', { name: 'Report source' })).toHaveAttribute('href', 'https://example.com/report')
    await expect(message.getByRole('link', { name: 'Unsafe source' })).toHaveCount(0)
    await expect(message.getByRole('link', { name: 'picture' })).toHaveAttribute('href', 'https://example.com/a.png')
  }
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.getByRole('button', { name: 'Copy response', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${plain}\n\n${markdown}`)
  }
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export as Markdown' }).click()
  const download = await downloading
  const exported = await readFile((await download.path())!, 'utf8')
  expect(exported).toContain(plain)
  expect(exported).toContain(markdown)
  expect(exported).not.toContain('displayed')
})

test('추론과 서브에이전트는 일반 텍스트이고 markdown 도구는 입력 완료·대기·실패 상태를 구분한다', async ({ page }) => {
  await seedChat(page, [{
    id: 'states', role: 'assistant', parts: [
      { type: 'reasoning', text: '**Raw reasoning**' },
      { type: 'tool-delegate_task', toolCallId: 'subagent', state: 'output-available', input: { task: 'Review formatting' }, output: { content: '**Raw subagent**' } },
      { type: 'tool-markdown', toolCallId: 'pending', state: 'input-streaming', input: { content: '# Incomplete content' } },
      { type: 'tool-markdown', toolCallId: 'available', state: 'input-available', input: { content: '### Ready content' } },
      { type: 'tool-markdown', toolCallId: 'failed', state: 'output-error', input: { content: '# Failed content' }, errorText: 'Markdown interrupted' }
    ]
  }])
  await ready(page, '/chat/browser-fixture')
  const message = page.locator('#message-states')
  await expect(message.getByRole('heading', { name: 'Ready content' })).toBeVisible()
  await expect(message.getByRole('heading', { name: 'Incomplete content' })).toHaveCount(0)
  await expect(message.getByRole('heading', { name: 'Failed content' })).toHaveCount(0)
  await expect(message.getByText('Preparing Markdown…')).toBeVisible()
  await message.getByRole('button', { name: /Thought/ }).click()
  await expect(message.getByText('**Raw reasoning**', { exact: true })).toBeVisible()
  await message.getByRole('button', { name: /Subagent completed/ }).click()
  await expect(message.getByText('**Raw subagent**', { exact: true })).toBeVisible()
  await message.getByRole('button', { name: /Markdown failed/ }).click()
  await expect(message.getByText('Markdown interrupted', { exact: true })).toBeVisible()
  await expect(message.locator('strong')).toHaveCount(0)
})

test.describe('터치 대화 목록', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('마우스를 올리지 않아도 이름 변경과 삭제 버튼을 보고 누를 수 있다', async ({ page }) => {
    await seedChat(page)
    await ready(page, '/chat/browser-fixture')
    await page.getByRole('button', { name: 'Open sidebar' }).tap()
    const rename = page.getByRole('button', { name: 'Rename: Browser fixture', exact: true })
    const remove = page.getByRole('button', { name: 'Delete: Browser fixture', exact: true })
    await expect(rename).toBeVisible()
    await expect(rename.locator('..')).toHaveCSS('opacity', '1')
    for (const button of [rename, remove]) {
      const box = await button.boundingBox()
      expect(Math.round(box!.width)).toBeGreaterThanOrEqual(44)
      expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44)
    }
    await rename.tap()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('textbox', { name: 'Chat title' }).fill('Mobile renamed')
    await page.getByRole('button', { name: 'Save', exact: true }).tap()
    await expect(page.getByRole('button', { name: 'Rename: Mobile renamed', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Delete: Mobile renamed', exact: true }).tap()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).tap()
    await expect(page.getByRole('button', { name: 'Rename: Mobile renamed', exact: true })).toBeVisible()
  })
})

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} 테마의 메시지 편집`, () => {
    test.use({ colorScheme })

    test('저장 버튼에 마우스를 올리거나 눌러도 접근성 위반이 없고 취소하면 원문을 보존한다 @a11y:message-edit', async ({ page }) => {
      await page.addInitScript(() => { localStorage.setItem('nuxt-color-mode', 'system') })
      await seedChat(page)
      await ready(page, '/chat/browser-fixture')
      await page.getByRole('button', { name: 'Edit message', exact: true }).first().click()
      const editor = page.getByRole('textbox', { name: 'Edit message', exact: true })
      await expect(editor).toBeVisible()
      const original = await editor.inputValue()
      await editor.fill('Discarded draft')
      await page.mouse.move(0, 0)
      await accessible(page)
      await page.getByRole('button', { name: 'Save', exact: true }).hover()
      await accessible(page)
      await page.mouse.down()
      try {
        await accessible(page)
      } finally {
        await page.mouse.move(0, 0)
        await page.mouse.up()
      }
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page.getByText(original, { exact: true })).toBeVisible()
      await expect(page.getByText('Discarded draft', { exact: true })).toHaveCount(0)
      await page.reload()
      await expect(page.getByText(original, { exact: true })).toBeVisible()
    })
  })
}
