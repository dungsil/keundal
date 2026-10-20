import { Service } from 'cordis'
import type { Context } from 'cordis'

import { appendContext, type ContextProvider } from './types.js'

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

/** Stable model guidance for interpreting ordinary @file prompt text. */
export const FILE_REFERENCE_PROMPT =
  'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.'

/** Add file-reference guidance only when the current request exposes a read tool. */
export function createFileReferenceContext(references?: { invalidate(): void }): ContextProvider {
  return (input, options) => {
    options.signal?.throwIfAborted()
    if (options.step > 1) references?.invalidate()
    if (!input.tools.some((tool) => tool.name === 'read' || tool.name === 'read_file')) return input
    return appendContext(input, 'file-reference:guidance', FILE_REFERENCE_PROMPT)
  }
}
