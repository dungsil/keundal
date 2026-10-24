import { getCitationUrl, getDomain } from '@keundal/ui/app/utils/url.ts'

/** Inline MDC that renders a citation as a `source-link`, or nothing when the URL is not a safe destination. */
export function sourceToInlineMdc(url: string): string {
  const destination = getCitationUrl(url)
  if (!destination) return ''

  const domain = getDomain(destination)
  const safeUrl = destination.replace(/"/g, '&quot;')

  return ` :source-link{url="${safeUrl}" label="${domain}"}`
}
