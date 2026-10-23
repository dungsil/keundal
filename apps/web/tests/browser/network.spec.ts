import { test, expect, ready } from './fixtures'

test.use({ externalFixtures: [{
  url: 'https://api.openai.com/v1/models',
  body: { object: 'list', data: [{ id: 'gpt-browser-fixture', object: 'model', created: 0, owned_by: 'openai' }] }
}] })

test('모델 목록은 명시한 API 응답으로 불러온다', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
  await context.addInitScript(() => {
    localStorage.setItem('keundal:llm-settings', JSON.stringify({ openai: { apiKey: 'browser-test-key', baseURL: 'https://api.openai.com/v1' } }))
    localStorage.setItem('keundal:default-model', 'openai/gpt-browser-fixture')
  })
  const response = page.waitForResponse('https://api.openai.com/v1/models')
  await ready(page, '/')
  await page.getByRole('button', { name: /Select model:/ }).click()
  expect((await response).status()).toBe(200)
  await expect(page.getByRole('option', { name: 'gpt-browser-fixture', exact: true })).toBeVisible()
})
