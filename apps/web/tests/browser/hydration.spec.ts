import { test, expect, ready } from './fixtures'

const settings = [
  { locale: 'en', browserLocale: 'ko-KR', expected: 'en', preference: 'light', scheme: 'dark', motion: 'reduce' },
  { locale: 'ko', browserLocale: 'en-US', expected: 'ko', preference: 'dark', scheme: 'light', motion: 'no-preference' },
  { locale: undefined, browserLocale: 'en-US', expected: 'en', preference: 'system', scheme: 'dark', motion: 'reduce' },
  { locale: 'invalid', browserLocale: 'ko-KR', expected: 'ko', preference: 'system', scheme: 'light', motion: 'no-preference' }
] as const

for (const setting of settings) {
  test.describe(`${setting.locale ?? '없음'} 쿠키와 ${setting.preference} 테마`, () => {
    test.use({ locale: setting.browserLocale, colorScheme: setting.scheme, contextOptions: { reducedMotion: setting.motion } })
    test('저장된 사용자 설정으로 오류 없이 화면을 활성화한다', async ({ page, context, baseURL }) => {
      await context.addCookies([
        ...(setting.locale ? [{ name: 'keundal-locale', value: setting.locale, url: baseURL! }] : []),
        { name: 'web-search', value: 'false', url: baseURL! },
        { name: 'reasoning', value: 'high', url: baseURL! }
      ])
      await context.addInitScript((preference) => {
        localStorage.setItem('nuxt-color-mode', preference)
      }, setting.preference)
      for (const path of ['/', '/settings/appearance', '/settings/llm']) {
        await ready(page, path)
        await expect(page.locator('html')).toHaveAttribute('lang', setting.expected)
        const theme = setting.preference === 'system' ? setting.scheme : setting.preference
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      }
      expect((await context.cookies()).find(cookie => cookie.name === 'web-search')?.value).toBe('false')
    })
  })
}

for (const storedModel of ['openai/gpt-5-nano', 'openai/gpt-4.1', 'google/gemini-3-pro', 'unknown/stale-model']) {
  test(`저장된 모델 ${storedModel}이 시작을 막지 않는다`, async ({ page, context }) => {
    await context.addInitScript((model) => {
      localStorage.setItem('keundal:default-model', model)
      localStorage.setItem('keundal:title-model', model)
    }, storedModel)
    await ready(page, '/')
    await expect(page.getByRole('textbox').first()).toBeVisible()
    if (!storedModel.startsWith('unknown/')) {
      await expect(page.getByRole('button', { name: new RegExp(storedModel.split('/')[1]!) })).toBeVisible()
      expect(await page.evaluate(() => ({
        defaultModel: localStorage.getItem('keundal:default-model'),
        titleModel: localStorage.getItem('keundal:title-model')
      }))).toEqual({ defaultModel: storedModel, titleModel: storedModel })
    }
  })
}
