import { diffLines } from 'diff'

export const WORKSPACE_CHANGES_EVENT = 'keundal.workspace-changes'
export interface FileChange {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  before?: string | null
  after?: string | null
  additions?: number
  deletions?: number
  reason?: 'binary' | 'oversized' | 'unsupported' | 'unreadable' | 'budget' | 'baseline'
  coarse?: boolean
}
export interface WorkspaceChanges {
  version: 1
  runId: string
  status: 'partial' | 'complete' | 'unavailable'
  files: FileChange[]
}
export interface DiffRow {
  kind: 'context' | 'added' | 'deleted'
  text: string
  oldLine?: number
  newLine?: number
  noNewline?: boolean
}
export function compareLines(before: string, after: string) {
  const diff = diffLines(before, after, { timeout: 50, maxEditLength: 2000 })
  const chunks = diff ?? [
    { value: before, removed: true, added: false },
    { value: after, added: true, removed: false }
  ]
  const rows: DiffRow[] = []
  let oldLine = 1
  let newLine = 1
  let additions = 0
  let deletions = 0
  for (const chunk of chunks) {
    if (!chunk.value) continue
    const lines = chunk.value.split('\n')
    if (lines.at(-1) === '') lines.pop()
    for (const [index, text] of lines.entries()) {
      const row: DiffRow = { kind: chunk.added ? 'added' : chunk.removed ? 'deleted' : 'context', text }
      if (!chunk.added) row.oldLine = oldLine++
      if (!chunk.removed) row.newLine = newLine++
      if (chunk.added) additions++
      if (chunk.removed) deletions++
      if (index === lines.length - 1 && !chunk.value.endsWith('\n')) row.noNewline = true
      rows.push(row)
    }
  }
  return { additions, deletions, rows, coarse: !diff }
}

/** Journal data may come from older hosts or imported conversations. */
export function isWorkspaceChanges(value: unknown): value is WorkspaceChanges {
  if (!value || typeof value !== 'object') return false
  const record = value as WorkspaceChanges
  return (
    record.version === 1 &&
    typeof record.runId === 'string' &&
    ['partial', 'complete', 'unavailable'].includes(record.status) &&
    Array.isArray(record.files) &&
    record.files.length <= 500 &&
    record.files.every(
      (file) =>
        file &&
        typeof file.path === 'string' &&
        ['added', 'modified', 'deleted'].includes(file.kind) &&
        (file.before === undefined || file.before === null || typeof file.before === 'string') &&
        (file.after === undefined || file.after === null || typeof file.after === 'string') &&
        (file.reason === undefined ||
          ['binary', 'oversized', 'unsupported', 'unreadable', 'budget', 'baseline'].includes(file.reason)) &&
        (file.additions === undefined || (Number.isSafeInteger(file.additions) && file.additions >= 0)) &&
        (file.deletions === undefined || (Number.isSafeInteger(file.deletions) && file.deletions >= 0))
    )
  )
}
