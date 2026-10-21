export function findPreview(comments, sha) {
  for (const comment of comments) {
    if (
      comment.user?.login !== 'github-actions[bot]' ||
      !comment.body?.includes('<!-- Sticky Pull Request Commentcloudflare-preview -->') ||
      !comment.body.includes(`커밋: \`${sha}\``)
    )
      continue
    const link = comment.body.match(/\[웹 프리뷰 열기\]\((https:\/\/[^\s)]+)\)/)?.[1]
    if (!link) continue
    try {
      const url = new URL(link)
      if (
        url.protocol === 'https:' &&
        url.hostname.endsWith('.workers.dev') &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
      ) {
        return url.origin
      }
    } catch {
      /* Ignore malformed preview links. */
    }
  }
}
