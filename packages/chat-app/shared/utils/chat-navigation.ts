interface ChatNavigationItem {
  id: string
  label: string
  createdAt: string
}

/** Keep the current chat reachable without mounting the entire history. */
export function sidebarChats<T extends ChatNavigationItem>(chats: T[], limit: number, currentId?: string): T[] {
  const visible = chats.slice(0, Math.max(1, limit))
  const current = currentId ? chats.find(chat => chat.id === currentId) : undefined
  if (current && !visible.some(chat => chat.id === current.id)) visible[visible.length - 1] = current
  return visible
}

export function historyQuery(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function historySort(value: unknown): 'newest' | 'oldest' {
  return value === 'oldest' ? 'oldest' : 'newest'
}

export function searchChatHistory<T extends ChatNavigationItem>(chats: T[], query: string, sort: 'newest' | 'oldest'): T[] {
  const search = query.trim().toLocaleLowerCase()
  return chats.filter(chat => chat.label.toLocaleLowerCase().includes(search)).sort((a, b) => {
    const byDate = a.createdAt.localeCompare(b.createdAt)
    return (sort === 'oldest' ? byDate : -byDate) || a.id.localeCompare(b.id)
  })
}

export function chatPath(id: string): string {
  return `/chat/${encodeURIComponent(id)}`
}

export function settingsReturnTo(value: unknown): string {
  return typeof value === 'string' && (value === '/' || value === '/history' || /^\/chat\/[^/?#]+$/.test(value)) ? value : '/'
}
