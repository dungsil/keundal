const baseUrl = new URL(process.env.LIGHTHOUSE_BASE_URL || 'http://localhost:3000')

module.exports = {
  ci: {
    // Initial policy thresholds, not measured application baselines. Calibrate with repeated CI reports.
    budgets: {
      performance: Number(process.env.LIGHTHOUSE_MIN_PERFORMANCE || 71),
      accessibility: Number(process.env.LIGHTHOUSE_MIN_ACCESSIBILITY || 90),
      cls: Number(process.env.LIGHTHOUSE_MAX_CLS || 0.1)
    },
    collect: {
      url: ['/', '/settings/appearance', '/settings/llm', '/settings/models', '/settings/mcp', '/settings/skills'].map(
        (path) => new URL(path, baseUrl).href
      ),
      numberOfRuns: 3,
      settings: {
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        skipAudits: ['is-crawlable']
      }
    }
  }
}
