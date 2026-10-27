import type {} from '@keundal/ui-slots'

/** A citation inserted after `offset` UTF-16 code units of the original Markdown. */
export interface MarkdownSource {
  offset: number
  url: string
}

/** Renderer-independent input shared by assistant text, reasoning and subagent answers. */
export interface MarkdownOwner {
  value: string
  streaming?: boolean
  sources?: readonly MarkdownSource[]
}

declare module '@keundal/ui-slots' {
  interface FactoryMap {
    markdown: { owner: MarkdownOwner }
  }
}
