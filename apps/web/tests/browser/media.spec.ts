import { test, expect, ready, accessible } from './fixtures'

test('로컬 웹 실행 방식에는 미디어 기능이나 실행 폼을 표시하지 않는다', async ({ page }) => {
  await ready(page, '/settings/runtime-plugins')
  await expect(page.getByRole('switch', { name: 'Enable Media', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Media', exact: true })).toHaveCount(0)
  await ready(page, '/library')
  await expect(page.getByRole('button', { name: 'Start download', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Transcribe', exact: true })).toHaveCount(0)
  await accessible(page)
})
