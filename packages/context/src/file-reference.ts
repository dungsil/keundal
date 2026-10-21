import { Service } from 'cordis'
import type { Context } from 'cordis'

/** One path-only file or directory completion candidate. */
export interface FileReferenceCandidate {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/** Active `@path` token ending at the editor cursor. */
export interface ActiveAtToken {
  readonly prefix: string
  readonly query: string
  readonly quoted: boolean
}

/** Recognize the active @-mention at a cursor position. */
export function activeAtToken(line: string, cursorCol: number): ActiveAtToken | undefined {
  const prefixText = line.slice(0, cursorCol)
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(prefixText)
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { prefix: quoted[1], query: quoted[2], quoted: true }
  }
  const plain = /(?:^|\s)(@([^\s"]*))$/u.exec(prefixText)
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined
  return { prefix: plain[1], query: plain[2], quoted: false }
}

/** Format a selected candidate as safe prompt text; quoted directories remain open for descent. */
export function formatFileMention(candidate: FileReferenceCandidate, preserveQuote = false): string | undefined {
  const path = candidate.kind === 'directory' && !candidate.path.endsWith('/') ? `${candidate.path}/` : candidate.path
  for (const character of path) {
    const code = character.codePointAt(0)!
    if (code < 32 || (code >= 127 && code <= 159) || character === '"') return undefined
  }
  if (!preserveQuote && !/\s/u.test(path)) return `@${path}`
  return candidate.kind === 'directory' ? `@"${path}` : `@"${path}"`
}

/** Cordis seam for path-only file discovery. */
export abstract class FileReferenceService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fileReferences')
  }

  abstract list(query: string, signal?: AbortSignal): Promise<FileReferenceCandidate[]>
}

declare module 'cordis' {
  interface Context {
    readonly fileReferences: FileReferenceService
  }
}
