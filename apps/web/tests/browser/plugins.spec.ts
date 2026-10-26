import { test, expect, ready, accessible } from './fixtures'

test('스킬·MCP 선택에 따라 해당 화면을 해제하고 새로고침 후에도 기능 선택을 유지한다 @a11y:runtime-plugins', async ({ page, context }) => {
  await context.addInitScript(() => {
    if (globalThis.location.protocol !== 'http:') return
    localStorage.setItem('keundal:runtime-plugins', JSON.stringify([{ module: 'https://not-requested.invalid/old.mjs', enabled: true }]))
    const legacySelections = {
      '@keundal/ui-home': false,
      '@keundal/ui-settings-llm': false,
      '@keundal/ui-agent-plugins': false,
      '@keundal/ui-skill': false,
      '@keundal/ui-mcp': false,
      '@keundal/ui-tool': false
    }
    globalThis.document.cookie = `keundal-ui-plugins=${encodeURIComponent(JSON.stringify(legacySelections))}; path=/`
  })
  await ready(page, '/settings/runtime-plugins')
  const skills = page.getByRole('switch', { name: 'Enable Skills', exact: true })
  const mcp = page.getByRole('switch', { name: 'Enable MCP connections', exact: true })
  const tools = page.getByRole('switch', { name: 'Enable Weather and charts', exact: true })
  const skillsLink = page.getByRole('link', { name: 'Skills', exact: true })
  const mcpLink = page.getByRole('link', { name: 'MCP servers', exact: true })
  await expect(skills).toBeEnabled()
  await expect(skills).toBeChecked()
  await expect(mcp).toBeChecked()
  await expect(tools).toBeChecked()
  await expect(skillsLink).toBeVisible()
  await expect(mcpLink).toBeVisible()
  await expect(page.getByRole('link', { name: 'Agent plugins', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'LLM', exact: true })).toBeVisible()
  await expect(page.getByRole('switch')).toHaveCount(6)
  await expect(page.getByRole('switch', { name: /@keundal\/ui-/ })).toHaveCount(0)
  await expect(page.getByText(/@keundal\/ui-/)).toHaveCount(0)
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Install|Add plugin/ })).toHaveCount(0)
  for (const name of ['Browser model connection', 'Browser storage', 'Chat agent']) {
    const required = page.getByRole('switch', { name: `Enable ${name}`, exact: true })
    await expect(required).toBeDisabled()
    await expect(required).toBeChecked()
  }
  await expect(page.getByText('https://not-requested.invalid/old.mjs', { exact: true })).toHaveCount(0)
  await accessible(page)
  await skills.click()
  await expect(skills).not.toBeChecked()
  await expect(skillsLink).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('keundal:bundled-plugins')!)['@keundal/plugin-skill'])).toBe(false)
  await expect(mcpLink).toBeVisible()
  await mcp.click()
  await expect(mcp).not.toBeChecked()
  await expect(mcpLink).toHaveCount(0)
  await expect(skills).not.toBeChecked()
  await expect(skillsLink).toHaveCount(0)
  await mcp.click()
  await expect(mcp).toBeChecked()
  await expect(mcpLink).toBeVisible()
  await expect(skills).not.toBeChecked()
  await expect(skillsLink).toHaveCount(0)
  await page.reload()
  await expect(skills).not.toBeChecked()
  await expect(skillsLink).toHaveCount(0)
  await expect(mcp).toBeChecked()
  await expect(mcpLink).toBeVisible()
  await expect(skills).toBeEnabled()
  await skills.focus()
  await page.keyboard.press('Space')
  await expect(skills).toBeChecked()
  await expect(skillsLink).toBeVisible()

  await tools.click()
  await expect(tools).not.toBeChecked()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('keundal:bundled-plugins')!)['@keundal/plugin-tool-chat'])).toBe(false)
  await page.reload()
  await expect(tools).not.toBeChecked()
  await expect(skillsLink).toBeVisible()
  await expect(mcpLink).toBeVisible()
  await expect(page.getByRole('link', { name: 'Agent plugins', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: /@keundal\/ui-/ })).toHaveCount(0)
  await accessible(page)
  await tools.click()
  await expect(tools).toBeChecked()
})

test('선택한 언어로 기능 이름과 설명 및 스위치 이름을 표시한다', async ({ page, context }) => {
  await ready(page, '/settings/runtime-plugins')
  await expect(page.getByText('Skills', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Provides reusable instructions for the agent to load when needed.', { exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Enable Skills', exact: true })).toBeChecked()
  await context.addCookies([{ name: 'keundal-locale', value: 'ko', url: page.url() }])
  await page.reload()
  await expect(page.getByText('스킬', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('에이전트가 필요할 때 불러올 수 있는 재사용 가능한 지침을 제공합니다.', { exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '스킬 활성화', exact: true })).toBeChecked()
  await expect(page.getByRole('switch', { name: '브라우저 저장소 활성화', exact: true })).toBeDisabled()
  await expect(page.getByText('@keundal/plugin-skill', { exact: true })).toHaveCount(0)
})
