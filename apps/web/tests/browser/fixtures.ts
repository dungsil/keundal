import AxeBuilder from '@axe-core/playwright'
import { test as base, expect, type Page } from '@playwright/test'

type NetworkFixture = { url: string, body: unknown, status?: number }
type Fixtures = {
  externalFixtures: NetworkFixture[]
  browserDiagnostics: void
}

export const test = base.extend<Fixtures>({
  externalFixtures: [[], { option: true }],
  browserDiagnostics: [async ({ context, baseURL, externalFixtures }, use, testInfo) => {
    const errors: string[] = []
    await context.exposeBinding('__recordCspViolation', (_, message: string) => errors.push(message))
    await context.addInitScript(() => {
      globalThis.document.addEventListener('securitypolicyviolation', (event) => {
        const record = (globalThis as unknown as { __recordCspViolation: (message: string) => void }).__recordCspViolation
        record(`CSP: ${event.violatedDirective} ${event.blockedURI}`)
      })
    })
    context.on('page', (page) => {
      page.on('pageerror', error => errors.push(`Page error: ${error.message}`))
      page.on('console', (message) => {
        if (message.type() === 'error' || /hydration|content security policy/i.test(message.text())) {
          errors.push(`Console ${message.type()}: ${message.text()}`)
        }
      })
    })
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin === new URL(baseURL!).origin) return route.continue()
      const fixture = externalFixtures.find(item => item.url === url.href)
      if (fixture) return route.fulfill({ status: fixture.status ?? 200, json: fixture.body, headers: { 'access-control-allow-origin': '*' } })
      errors.push(`Unexpected external request: ${url.href}`)
      await route.abort('blockedbyclient')
    })
    await use()
    await testInfo.attach('browser-diagnostics', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' })
    expect(errors, 'Browser errors and unexpected external requests').toEqual([])
  }, { auto: true }]
})

export { expect }

export async function ready(page: Page, path: string) {
  await page.goto(path)
  await expect(page).toHaveURL(new URL(path, page.url()).href)
  await expect(page.locator('div[aria-busy="false"]:has(main)')).toBeAttached()
  await expect(page.locator('[inert]')).toHaveCount(0)
  const pathname = new URL(page.url()).pathname
  const headings: Record<string, string> = {
    '/settings/appearance': '#appearance-settings-title',
    '/settings/llm': '#llm-settings-title',
    '/settings/models': '#model-settings-title',
    '/settings/system-prompt': '#system-prompt-settings-title',
    '/settings/subagents': '#subagent-settings-title',
    '/settings/mcp': '#mcp-settings-title',
    '/settings/skills': '#skill-settings-title',
    '/settings/plugins': '#plugin-settings-title',
    '/history': '#main-content h1'
  }
  if (headings[pathname]) await expect(page.locator(headings[pathname]!)).toBeVisible()
  else if (pathname === '/') await expect(page.getByRole('textbox').first()).toBeVisible()
  else if (pathname.startsWith('/chat/')) await expect(page.locator('[data-message-link]').first()).toBeAttached()
}

export async function accessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(results.violations).toEqual([])
}
