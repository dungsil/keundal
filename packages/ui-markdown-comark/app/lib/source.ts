import { getCitationUrl, getDomain } from '@keundal/ui/app/utils/url.ts'
import type { MarkdownSource } from '@keundal/ui/app/types/markdown.ts'

/** Inline MDC that renders a citation as a `source-link`, or nothing when the URL is not a safe destination. */
export function sourceToInlineMdc(url: string): string {
  const destination = getCitationUrl(url)
  if (!destination) return ''

  const domain = getDomain(destination)
  const safeUrl = destination.replace(/"/g, '&quot;')

  return ` :source-link{url="${safeUrl}" label="${domain}"}`
}

/** Sources arrive in text order; offsets refer to the unmodified input. */
export function withSources(value: string, sources: readonly MarkdownSource[]): string {
  let result = ''
  let start = 0
  for (const source of sources) {
    result += value.slice(start, source.offset) + sourceToInlineMdc(source.url)
    start = source.offset
  }
  return result + value.slice(start)
}
