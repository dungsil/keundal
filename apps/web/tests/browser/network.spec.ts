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

test.describe('LLM 설정의 모델 목록', () => {
  test('저장한 공급자를 열면 모델 목록을 자동으로 불러온다', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
    await context.addInitScript(() => {
      localStorage.setItem('keundal:llm-settings', JSON.stringify({ openai: { apiKey: 'browser-test-key', baseURL: 'https://api.openai.com/v1' } }))
    })
    const request = page.waitForRequest('https://api.openai.com/v1/models')
    await ready(page, '/settings/llm')
    await request
    await expect(page.getByText('gpt-browser-fixture')).toBeVisible()
  })

  test('새 공급자를 추가하면 모델 목록을 자동으로 불러오지 않는다', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'keundal-locale', value: 'en', url: baseURL! }])
    const requests: string[] = []
    page.on('request', (item) => {
      if (item.url().includes('/models')) requests.push(item.url())
    })
    await ready(page, '/settings/llm')
    await page.getByRole('button', { name: 'Add provider' }).click()
    await page.getByRole('button', { name: 'Continue setup' }).click()
    await expect(page.getByRole('button', { name: 'Load models' })).toBeVisible()
    await page.waitForTimeout(1500)
    expect(requests).toEqual([])
  })
})
