import { test, expect, ready, accessible } from './fixtures'

test('큰달 플러그인을 설치하면 비활성이며 활성화·새로고침·비활성화·삭제가 실행 효과에 반영된다', async ({ page, baseURL }) => {
  const module = `${baseURL}/test-runtime-plugin.mjs`
  await page.route('**/test-runtime-plugin.mjs', route => route.fulfill({
    contentType: 'text/javascript',
    body: `
      localStorage.setItem('test:plugin-imported', 'true');
      export default function (ctx, config) {
        ctx.effect(() => {
          document.body.setAttribute('data-test-plugin', config.value);
          return () => document.body.removeAttribute('data-test-plugin');
        });
      }
    `
  }))
  await ready(page, '/settings/runtime-plugins')
  await expect(page.getByRole('button', { name: 'Add plugin' })).toBeEnabled()
  await accessible(page)
  await page.getByRole('button', { name: 'Add plugin' }).click()
  await page.getByLabel('ESM URL').fill(module)
  await page.getByLabel('Configuration (JSON)').fill('{"value":"report-ready"}')
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeDisabled()
  await page.getByRole('checkbox').check()
  await page.getByLabel('Configuration (JSON)').fill('[]')
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Configuration must be a JSON object.')
  await expect(page.getByRole('switch')).toHaveCount(0)
  await page.getByLabel('Configuration (JSON)').fill('{"value":"report-ready"}')
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(page.getByText('Installed · Disabled', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('test:plugin-imported'))).toBeNull()
  const toggle = page.getByRole('switch', { name: `Enable ${module}`, exact: true })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(page.locator('body')).toHaveAttribute('data-test-plugin', 'report-ready')
  await page.reload()
  await expect(toggle).toBeChecked()
  await expect(page.locator('body')).toHaveAttribute('data-test-plugin', 'report-ready')
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(page.locator('body')).not.toHaveAttribute('data-test-plugin')
  await accessible(page)
  await page.getByRole('button', { name: `Delete ${module}`, exact: true }).click()
  await page.getByRole('button', { name: `Delete ${module}`, exact: true }).click()
  await expect(page.getByText('No Keundal plugins installed', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('keundal:runtime-plugins')!))).toEqual([])
})
