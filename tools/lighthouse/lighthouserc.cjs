const baseUrl = new URL(process.env.LIGHTHOUSE_BASE_URL || 'http://localhost:3000')

module.exports = {
  ci: {
    collect: {
      url: ['/', '/settings'].map((path) => new URL(path, baseUrl).href),
      numberOfRuns: 3,
      settings: {
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo']
      }
    }
  }
}
