export default {
  urls: ['/', '/settings/appearance', '/settings/llm', '/settings/models', '/settings/mcp', '/settings/skills'],
  outputPath: `.unlighthouse/run-${process.env.LIGHTHOUSE_RUN || 'local'}`,
  cache: false,
  scanner: {
    samples: 1,
    crawler: false,
    sitemap: false,
    skipJavascript: false,
    device: 'mobile',
    throttle: true
  },
  puppeteerOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  puppeteerClusterOptions: { maxConcurrency: 1 },
  lighthouseOptions: {
    throttling: { cpuSlowdownMultiplier: 4 },
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    skipAudits: ['is-crawlable']
  },
  ci: { reporter: 'jsonExpanded' }
}
