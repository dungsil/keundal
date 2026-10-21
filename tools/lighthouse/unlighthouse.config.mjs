export default {
  urls: ['/', '/settings'],
  outputPath: `.unlighthouse/run-${process.env.LIGHTHOUSE_RUN || 'local'}`,
  cache: false,
  scanner: {
    samples: 1,
    crawler: false,
    sitemap: false,
    skipJavascript: false,
    device: 'mobile'
  },
  puppeteerOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  puppeteerClusterOptions: { maxConcurrency: 1 },
  lighthouseOptions: {
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo']
  },
  ci: { reporter: 'jsonExpanded' }
}
