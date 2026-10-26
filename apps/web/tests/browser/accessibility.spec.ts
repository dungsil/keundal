import { test, expect, ready, accessible } from './fixtures'

test('홈 화면에 접근성 위반이 없다 @a11y:home', async ({ page }) => {
  await ready(page, '/')
  await accessible(page)
})

test('표시 설정 화면에 접근성 위반이 없다 @a11y:appearance', async ({ page }) => {
  await ready(page, '/settings/appearance')
  await accessible(page)
})

test('공급자와 프롬프트 프리셋 설정 화면에 접근성 위반이 없다 @a11y:llm @a11y:system-prompt', async ({ page }) => {
  await ready(page, '/settings/llm')
  await accessible(page)
  await ready(page, '/settings/system-prompt')
  await expect(page.getByRole('button', { name: 'Create preset', exact: true })).toBeEnabled()
  await accessible(page)
  await page.getByRole('button', { name: 'Create preset', exact: true }).click()
  await expect(page.getByLabel('Preset name', { exact: true })).toBeEnabled()
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

test.describe('모바일 설정 탐색', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('좁은 화면에서 모델 선택값은 한 줄로 줄이고 목록에서는 전체 이름을 표시한다', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
    await page.setViewportSize({ width: 320, height: 740 })
    const longName = `${'long-model-name-'.repeat(8)}end`
    const longModel = `openai/${longName}`
    for (const model of ['', longModel]) {
      await page.addInitScript((value) => {
        localStorage.setItem('keundal:default-model', value)
        localStorage.setItem('keundal:title-model', value)
      }, model)
      await ready(page, '/settings/models')
      for (const name of ['Chat model', 'Title generation model']) {
        const button = page.getByRole('button', { name, exact: true })
        const value = button.locator('[data-slot="value"]')
        await expect(value).toHaveCSS('text-overflow', 'ellipsis')
        const geometry = await value.evaluate(element => ({
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(globalThis.getComputedStyle(element).lineHeight)
        }))
        expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight + 1)
        await button.tap()
        const option = page.getByRole('option', { name: model ? longName : (name === 'Chat model' ? 'Use the last selected model' : 'Use the chat model'), exact: true })
        await expect(option).toBeVisible()
        await expect(option.locator('[data-slot="itemLabel"]')).toHaveCSS('white-space', 'normal')
        await page.keyboard.press('Escape')
      }
      const section = await page.getByRole('region', { name: 'Model settings', exact: true }).boundingBox()
      for (const name of ['Refresh models', 'Save']) {
        const button = await page.getByRole('button', { name, exact: true }).boundingBox()
        expect(button!.x + button!.width).toBeLessThanOrEqual(section!.x + section!.width + 1)
      }
      expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true)
    }
  })

  test('설정 선택 메뉴로 이동해도 돌아갈 대화와 작성 중인 내용을 보존한다', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
    await ready(page, '/settings/system-prompt?returnTo=/chat/mobile-fixture')
    await page.getByRole('button', { name: 'Create preset', exact: true }).tap()
    await page.getByLabel('Content', { exact: true }).fill('Unsaved mobile draft')
    const picker = page.getByRole('button', { name: 'Settings: Prompt presets', exact: true })
    await picker.tap()
    await expect(page.getByRole('menuitem')).toHaveCount(9)
    await expect(page.getByRole('menuitem', { name: 'Subagents', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Keundal plugins', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Agent plugins', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Prompt presets', exact: true })).toHaveAttribute('aria-current', 'page')
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
    await page.getByRole('menuitem', { name: 'Prompt presets', exact: true }).tap()
    await expect(page.getByLabel('Content', { exact: true })).toHaveValue('Unsaved mobile draft')
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
