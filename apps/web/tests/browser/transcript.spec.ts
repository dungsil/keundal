import { readFile } from 'node:fs/promises'
import { test, expect, ready, accessible } from './fixtures'

async function seedChat(page: import('@playwright/test').Page) {
  await ready(page, '/')
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open('keundal-web', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const messages = Array.from({ length: 85 }, (_, index) => ({
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
  })
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
