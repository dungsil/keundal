import type {} from '@keundal/ui-slots'

/** Values every sidebar entry receives. */
export interface SidebarOwner {
  /** The sidebar shows icons only. */
  collapsed: boolean
  /** Close the sidebar on small screens, for example after navigating. */
  close(): void
}

declare module '@keundal/ui-slots' {
  interface SlotMap {
    /** The page at `/`. */
    'page.home': { kind: 'single'; owner: Record<string, never> }
    /** The page at `/chat/:id`. */
    'page.chat': { kind: 'single'; owner: { chatId: string } }
    /** The page at `/history`. */
    'page.history': { kind: 'single'; owner: Record<string, never> }
    /** The pages under `/settings`. */
    'page.settings': { kind: 'single'; owner: { section: string } }
    /** Sidebar body, ordered by `order`. */
    'layout.sidebar': { kind: 'list'; owner: SidebarOwner }
    /** Sidebar footer, ordered by `order`. */
    'layout.sidebar.footer': { kind: 'list'; owner: SidebarOwner }
    /** Dialogs and other overlays that live beside the pages. */
    'layout.overlay': { kind: 'list'; owner: Record<string, never> }
    /** The media library page at `/library`. */
    'page.library': { kind: 'single'; owner: Record<string, never> }
  }
}
