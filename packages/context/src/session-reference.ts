import type { RunAgentInput } from '@keundal/core'
import { Service, type Context } from 'cordis'

export const SESSION_REFERENCE_SCHEME = 'keundal-session:'

export type SessionReferenceErrorCode =
  | 'SESSION_REFERENCE_INVALID_CONFIG'
  | 'SESSION_REFERENCE_INVALID_REFERENCE'
  | 'SESSION_REFERENCE_SELF_REFERENCE'
  | 'SESSION_REFERENCE_TOO_MANY'
  | 'SESSION_REFERENCE_READ_FAILED'
  | 'SESSION_REFERENCE_BUDGET_EXCEEDED'
  | 'SESSION_REFERENCE_CANCELLED'

export class SessionReferenceError extends Error {
  constructor(
    message: string,
    readonly code: SessionReferenceErrorCode,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SessionReferenceError'
  }
}

export interface SessionReferenceInput {
  readonly sessionId: string
  readonly label?: string
}

export interface SessionReferenceCandidate {
  readonly sessionId: string
  readonly label: string
  readonly displayTitle?: string
  readonly cwd?: string
  readonly sameWorkspace: boolean
  readonly createdAt: number
}

export interface ParsedSessionReferenceText {
  readonly text: string
  readonly references: SessionReferenceInput[]
}

export abstract class SessionReferenceService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionReferenceResolver')
  }

  abstract listCandidates(
    threadId: string,
    query?: string,
    limit?: number,
    signal?: AbortSignal
  ): Promise<SessionReferenceCandidate[]>
  abstract prepare(
    input: RunAgentInput,
    request: RunAgentInput,
    signal?: AbortSignal,
    contextWindow?: number
  ): Promise<RunAgentInput>
}

declare module 'cordis' {
  interface Context {
    readonly sessionReferenceResolver: SessionReferenceService
  }
}

export function encodeSessionReferenceUri(sessionId: string): string {
  const bytes = new globalThis.TextEncoder().encode(JSON.stringify(sessionId))
  const payload = globalThis
    .btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
  return `${SESSION_REFERENCE_SCHEME}${payload}`
}

export function decodeSessionReferenceUri(uri: string): string {
  const prefix = uri.startsWith(SESSION_REFERENCE_SCHEME) ? SESSION_REFERENCE_SCHEME : 'dsh-session:'
  if (!uri.startsWith(prefix)) throw invalidReference(uri)
  const payload = uri.slice(prefix.length)
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) throw invalidReference(uri)
  try {
    const binary = globalThis.atob(payload.replaceAll('-', '+').replaceAll('_', '/'))
    const decoded: unknown = JSON.parse(
      new globalThis.TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
    )
    if (typeof decoded !== 'string') throw new TypeError('session id payload is not a string')
    if (encodeSessionReferenceUri(decoded).slice(SESSION_REFERENCE_SCHEME.length) !== payload)
      throw new TypeError('non-canonical URI')
    return decoded
  } catch (cause) {
    throw invalidReference(uri, cause)
  }
}

export function formatSessionReferenceMention(reference: SessionReferenceInput): string {
  const label = (reference.label ?? reference.sessionId).replace(/[\\\]]/gu, '\\$&')
  return `@[${label}](${encodeSessionReferenceUri(reference.sessionId)})`
}

export function parseSessionReferenceText(text: string): ParsedSessionReferenceText {
  const references: SessionReferenceInput[] = []
  const parts: string[] = []
  let copiedThrough = 0
  let labelEnd = 0
  let cursor = 0
  while (cursor < text.length) {
    let uriStart = cursor
    let labelStart: number | undefined
    if (text.startsWith('@[', cursor)) {
      if (labelEnd < cursor + 2) {
        labelEnd = cursor + 2
        while (labelEnd < text.length && text[labelEnd] !== ']') {
          labelEnd += text[labelEnd] === '\\' ? 2 : 1
        }
      }
      if (text.startsWith('](', labelEnd)) {
        uriStart = labelEnd + 2
        labelStart = cursor + 2
      }
    }
    const scheme = text.startsWith(SESSION_REFERENCE_SCHEME, uriStart)
      ? SESSION_REFERENCE_SCHEME
      : text.startsWith('dsh-session:', uriStart)
        ? 'dsh-session:'
        : undefined
    if (!scheme) {
      cursor++
      continue
    }
    let end = uriStart + scheme.length
    if (labelStart !== undefined) {
      while (end < text.length && text[end] !== ')' && !/\s/u.test(text[end]!)) end++
      if (text[end] !== ')') throw invalidReference(text.slice(uriStart, end))
    } else {
      while (end < text.length && /[A-Za-z0-9_-]/u.test(text[end]!)) end++
      if (end === uriStart + scheme.length) {
        cursor = end
        continue
      }
    }
    const sessionId = decodeSessionReferenceUri(text.slice(uriStart, end))
    const label = labelStart === undefined ? sessionId : text.slice(labelStart, labelEnd).replace(/\\(.)/gu, '$1')
    references.push({ sessionId, label })
    parts.push(text.slice(copiedThrough, cursor), `@${label}`)
    cursor = labelStart === undefined ? end : end + 1
    copiedThrough = cursor
  }
  if (!references.length) return { text, references }
  parts.push(text.slice(copiedThrough))
  return { text: parts.join(''), references }
}

function invalidReference(value: string, cause?: unknown): SessionReferenceError {
  return new SessionReferenceError(
    `invalid session reference ${JSON.stringify(value)}`,
    'SESSION_REFERENCE_INVALID_REFERENCE',
    cause === undefined ? undefined : { cause }
  )
}
