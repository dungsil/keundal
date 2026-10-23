import { test, expect, ready } from './fixtures'

for (const colorScheme of ['light', 'dark'] as const) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test.describe(`${colorScheme} 테마와 ${viewport.width}px 화면`, () => {
      test.use({ colorScheme, viewport, locale: 'en-US', contextOptions: { reducedMotion: 'reduce' } })
      test('표시 설정 화면이 기준 이미지와 일치한다 @visual', async ({ page, context, baseURL }) => {
        await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
        await context.addInitScript(() => { localStorage.setItem('nuxt-color-mode', 'system') })
        await ready(page, '/settings/appearance')
        await expect(page).toHaveScreenshot(`appearance-${colorScheme}-${viewport.width}.png`, {
          animations: 'disabled',
          fullPage: true
        })
      })
    })
  }
}
