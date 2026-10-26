import { test, expect, ready, accessible } from './fixtures'

test('홈 화면에 접근성 위반이 없다 @a11y:home', async ({ page }) => {
  await ready(page, '/')
  await accessible(page)
})

test('표시 설정 화면에 접근성 위반이 없다 @a11y:appearance', async ({ page }) => {
  await ready(page, '/settings/appearance')
  await accessible(page)
})

test('공급자와 시스템 프롬프트 설정 화면에 접근성 위반이 없다 @a11y:llm @a11y:system-prompt', async ({ page }) => {
  await ready(page, '/settings/llm')
  await accessible(page)
  await ready(page, '/settings/system-prompt')
  await expect(page.getByRole('textbox')).toBeEnabled()
  await accessible(page)
})

test('모델 설정 화면에 접근성 위반이 없다 @a11y:models', async ({ page }) => {
  await ready(page, '/settings/models')
  await accessible(page)
})

test('MCP 설정 화면에 접근성 위반이 없다 @a11y:mcp', async ({ page }) => {
  await ready(page, '/settings/mcp')
  await accessible(page)
})

test('스킬 설정 화면에 접근성 위반이 없다 @a11y:skills', async ({ page }) => {
  await ready(page, '/settings/skills')
  await accessible(page)
})

test('에이전트 설정 화면에 접근성 위반이 없다 @a11y:plugins', async ({ page }) => {
  await ready(page, '/settings/plugins')
  await accessible(page)
})

test('대화 기록 화면에 접근성 위반이 없다 @a11y:history', async ({ page }) => {
  await ready(page, '/history')
  await accessible(page)
})

test('언어 선택 메뉴를 키보드로 열고 변경할 수 있다 @a11y:language-menu', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
  await ready(page, '/settings/appearance')
  const language = page.getByRole('combobox', { name: 'Language' })
  await language.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('select')).toHaveValue('ko')
  await accessible(page)
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await page.reload()
  await expect(page.locator('div[aria-busy="false"]:has(main)')).toBeAttached()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
})

test('프롬프트 메뉴에 저장된 검색 설정이 표시되고 접근성 위반이 없다 @a11y:prompt-menu', async ({ page, context, baseURL }) => {
  await context.addCookies([
    { name: 'keundal-locale', value: 'en', url: baseURL! },
    { name: 'web-search', value: 'false', url: baseURL! }
  ])
  await ready(page, '/')
  await page.getByRole('button', { name: 'Open prompt menu' }).click()
  const search = page.getByRole('menuitemcheckbox', { name: 'Web search' })
  await expect(search).toBeVisible()
  await expect(search).toHaveAttribute('aria-checked', 'false')
  await accessible(page)
  await page.keyboard.press('Escape')
  await expect(search).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open prompt menu' })).toBeFocused()
})

test.describe('모바일 설정 탐색', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('설정 선택 메뉴로 이동해도 돌아갈 대화와 작성 중인 내용을 보존한다', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
    await ready(page, '/settings/system-prompt?returnTo=/chat/mobile-fixture')
    await page.getByRole('textbox').fill('Unsaved mobile draft')
    const picker = page.getByRole('button', { name: 'Settings: System prompt', exact: true })
    await picker.tap()
    await expect(page.getByRole('menuitem')).toHaveCount(7)
    await expect(page.getByRole('menuitem', { name: 'System prompt', exact: true })).toHaveAttribute('aria-current', 'page')
    await accessible(page)
    await page.keyboard.press('Escape')
    await expect(picker).toBeFocused()
    await picker.tap()
    await page.getByRole('menuitem', { name: 'Appearance', exact: true }).tap()
    await expect(page.getByRole('button', { name: 'Settings: Appearance', exact: true })).toBeVisible()
    await expect(page.getByRole('menu')).toBeHidden()
    await expect(page.getByRole('link', { name: 'Back to chat' })).toHaveAttribute('href', '/chat/mobile-fixture')
    const heading = await page.locator('#appearance-settings-title').boundingBox()
    expect(heading!.y).toBeLessThan(400)
    await accessible(page)
    await page.getByRole('button', { name: 'Settings: Appearance', exact: true }).tap()
    await page.getByRole('menuitem', { name: 'System prompt', exact: true }).tap()
    await expect(page.getByRole('textbox')).toHaveValue('Unsaved mobile draft')
  })
})

for (const hasTouch of [true, false]) {
  test.describe(hasTouch ? '터치 입력' : '데스크톱 입력', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch,
      externalFixtures: [
        { url: 'https://api.anthropic.com/v1/messages/count_tokens', body: { input_tokens: 10 } },
        { url: 'https://api.anthropic.com/v1/messages', status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Browser fixture: generation disabled' } } }
      ]
    })

    test(hasTouch ? 'Enter는 줄바꿈하고 전송 버튼은 입력을 제출한다' : '좁은 화면에서도 키보드 Enter로 입력을 제출한다', async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
      await ready(page, '/')
      const prompt = page.getByRole('textbox', { name: 'Ask anything…' })
      await prompt.fill('First line')
      await prompt.press('Enter')
      if (hasTouch) {
        await expect(prompt).toHaveValue('First line\n')
        await expect(page).toHaveURL(baseURL! + '/')
        await page.locator('button[type="submit"]').tap()
      }
      await expect(page).toHaveURL(/\/chat\/[^/]+$/)
      await expect(page.getByRole('log', { name: 'Conversation messages' }).getByText('First line', { exact: true })).toBeVisible()
    })
  })
}
