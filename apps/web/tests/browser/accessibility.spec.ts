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

for (const [locale, label] of [['en', 'Agent plugins'], ['ko', '에이전트 플러그인']] as const) {
  test.describe(`${locale} 언어`, () => {
    test('에이전트 플러그인 메뉴와 화면 제목이 일치하고 접근성 위반이 없다 @a11y:plugins', async ({ page, context, baseURL }) => {
      await context.addCookies([{ name: 'keundal-locale', value: locale, url: baseURL! }])
      await ready(page, '/settings/plugins')
      await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: /Installed plugins|설치된 플러그인/ })).toHaveCount(0)
      await accessible(page)
    })
  })
}

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
