import type {} from '@keundal/ui-slots'

/** Shared slot contracts; implementations own their runtime declarations. */
/** Values every sidebar entry receives. */
export interface SidebarOwner {
  /** The sidebar shows icons only. */
  collapsed: boolean
  /** Close the sidebar on small screens, for example after navigating. */
  close(): void
}

declare module '@keundal/ui-slots' {
  interface SlotMap {
    /** Application frame inside the startup shell. */
    'app.layout': { kind: 'single'; owner: Record<string, never> }
    /** Navigation container beside the main content. */
    'layout.navigation': { kind: 'single'; owner: Record<string, never> }
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
  }
}
