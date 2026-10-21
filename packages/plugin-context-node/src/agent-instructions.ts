import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { appendContext, CONTEXT_MESSAGE_PREFIX, type ContextOptions, type ContextProvider } from '@keundal/context'
import type { RunAgentInput } from '@keundal/core'
import type { FileSystemService } from '@keundal/fs'

export interface AgentInstructionsConfig {
  readonly cwd?: string | ((request: RunAgentInput) => string | Promise<string>)
  readonly userGlobalPaths?: readonly string[]
  readonly projectRootMarkers?: readonly string[]
  readonly instructionFileCandidates?: readonly string[]
  readonly localInstructionFileCandidates?: readonly string[]
  readonly maxBytes?: number
  readonly maxSourceBytes?: number
}

interface Source {
  path: string
  display: string
  scope: string
  content: string
  digest: string
}
interface Rendered {
  text: string
  state: Source[]
}
const KEY = 'agent-instructions'
const DEFAULT_FILES = ['AGENTS.md', 'CLAUDE.md']
const DEFAULT_LOCAL_FILES = ['AGENTS.local.md', 'CLAUDE.local.md']
const DEFAULT_GLOBALS = [join(homedir(), '.keundal'), join(homedir(), '.agents')]
const CLOSE = '</system-reminder>'
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8')
const escaped = (value: string) => value.replaceAll(CLOSE, '<\\/system-reminder>')

function renderSource(source: Source, heading: string): string {
  return `${escaped(heading)}\n\n${escaped(source.content)}`
}

function stateKey(sources: readonly Source[]): string {
  const state = sources.map(({ path, display, scope, digest }) => ({ path, display, scope, digest }))
  return `${KEY}:${Buffer.from(JSON.stringify(state)).toString('base64url')}`
}

function readState(messages: RunAgentInput['messages']): Map<string, Source> {
  const state = new Map<string, Source>()
  const prefix = `${CONTEXT_MESSAGE_PREFIX}${encodeURIComponent(KEY)}%3A`
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string' || !message.id.startsWith(prefix)) continue
    const encoded = message.id.slice(prefix.length).split(':', 1)[0]
    try {
      const records: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
      if (!Array.isArray(records)) continue
      state.clear()
      for (const entry of records) {
        if (!entry || typeof entry !== 'object') continue
        const source = entry as Record<string, unknown>
        if (
          typeof source.path !== 'string' ||
          typeof source.display !== 'string' ||
          typeof source.scope !== 'string' ||
          typeof source.digest !== 'string'
        )
          continue
        state.set(source.path, {
          path: source.path,
          display: source.display,
          scope: source.scope,
          digest: source.digest,
          content: ''
        })
      }
    } catch {
      /* malformed durable state is ignored */
    }
  }
  return state
}

function parseSuccessfulTouches(input: RunAgentInput): string[] {
  const successfulCalls = new Set(
    input.messages.flatMap((message) => (message.role === 'tool' ? [message.toolCallId] : []))
  )
  const paths: string[] = []
  for (const message of input.messages) {
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls ?? []) {
      if (
        !successfulCalls.has(call.id) ||
        !['read_file', 'write_file', 'edit_file', 'read', 'write', 'edit'].includes(call.function.name)
      )
        continue
      try {
        const args: unknown = JSON.parse(call.function.arguments || '{}')
        if (!args || typeof args !== 'object' || Array.isArray(args)) continue
        const record = args as Record<string, unknown>
        const value = typeof record.path === 'string' ? record.path : record.file_path
        if (typeof value === 'string' && value.trim()) paths.push(value.trim())
      } catch {
        /* malformed calls cannot identify a filesystem path */
      }
    }
  }
  return paths
}

async function readInstruction(
  fs: FileSystemService,
  path: string,
  maxSourceBytes: number,
  options: ContextOptions
): Promise<{ content: string; oversized: boolean } | undefined> {
  try {
    const resolved = await fs.resolve(path, options.signal ? { signal: options.signal } : undefined)
    options.signal?.throwIfAborted()
    const snapshot = await fs.read(resolved, {
      ...(options.signal ? { signal: options.signal } : {}),
      scope: options.request.threadId
    })
    options.signal?.throwIfAborted()
    const content = snapshot.content.trim()
    return byteLength(content) > maxSourceBytes ? { content: '', oversized: true } : { content, oversized: false }
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND'].includes(String(error.code)))
      return undefined
    throw error
  }
}

async function projectRoot(
  fs: FileSystemService,
  cwd: string,
  markers: readonly string[],
  options: ContextOptions
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    options.signal?.throwIfAborted()
    const entries = await fs.list(current, {
      ...(options.signal ? { signal: options.signal } : {}),
      scope: options.request.threadId
    })
    if (entries.some((entry) => markers.includes(entry.name))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

function directoryChain(root: string, cwd: string): string[] {
  const result: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    result.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  result.push(resolvedRoot)
  return result.reverse()
}

function utf8Prefix(bytes: Buffer, length: number): string {
  let end = Math.min(length, bytes.length)
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

function baselineText(sources: readonly Source[], maxBytes: number, oversized: readonly string[]): Rendered {
  const intro =
    'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'
  const selected = [...sources]
  const omitted = [...oversized]
  const render = (items: readonly Source[], omittedPaths: readonly string[]) => {
    const sections = items.map((source) => renderSource(source, `Instructions from: ${source.display}`))
    const notice = omittedPaths.length
      ? `\n\nWorkspace instruction budget: ${escaped(omittedPaths.join(', '))} omitted or truncated.`
      : ''
    return `<system-reminder>\n${intro}${sections.length ? `\n\n${sections.join('\n\n')}` : ''}${notice}\n</system-reminder>`
  }
  while (selected.length > 1 && byteLength(render(selected, omitted)) > maxBytes)
    omitted.unshift(selected.shift()!.display)
  if (selected.length && byteLength(render(selected, omitted)) > maxBytes) {
    const mostSpecific = selected.at(-1)!
    const broader = selected.slice(0, -1)
    while (broader.length && byteLength(render([...broader, { ...mostSpecific, content: '' }], omitted)) > maxBytes)
      omitted.unshift(broader.shift()!.display)
    omitted.push(`${mostSpecific.display} (truncated)`)
    const sourceBytes = Buffer.from(mostSpecific.content, 'utf8')
    let low = 0
    let high = sourceBytes.length
    let best: string | undefined
    let bestContent = ''
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2)
      const content = utf8Prefix(sourceBytes, midpoint)
      const candidate = render([...broader, { ...mostSpecific, content }], omitted)
      if (byteLength(candidate) <= maxBytes) {
        best = candidate
        bestContent = content
        low = midpoint + 1
      } else high = midpoint - 1
    }
    if (best !== undefined) return { text: best, state: [...broader, { ...mostSpecific, content: bestContent }] }
    return { text: '', state: [] }
  }
  if (!selected.length && byteLength(render([], omitted)) > maxBytes) return { text: '', state: [] }
  const text = selected.length || omitted.length ? render(selected, omitted) : ''
  return { text: byteLength(text) <= maxBytes ? text : '', state: selected }
}

function changeText(current: readonly Source[], previous: Map<string, Source>, maxBytes: number): Rendered {
  const now = new Map(current.map((source) => [source.path, source]))
  const changes: Array<{ text: string; source?: Source; remove?: string; heading?: string }> = []
  for (const source of current) {
    const old = previous.get(source.path)
    if (!old) {
      const heading = `Additional instructions from: ${source.display}\n\nThese instructions apply to work under \`${source.scope}\`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.`
      changes.push({ text: renderSource(source, heading), source, heading })
    } else if (old.digest !== source.digest || old.display !== source.display) {
      const heading = `Updated instructions from: ${source.display}\n\nThis file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.`
      changes.push({ text: renderSource(source, heading), source, heading })
    }
  }
  for (const old of previous.values()) {
    if (!now.has(old.path))
      changes.push({
        text: escaped(
          `Instructions removed: ${old.display}\n\nThe previously loaded instructions from this file no longer apply.`
        ),
        remove: old.path
      })
  }
  if (!changes.length) return { text: '', state: [...previous.values()] }
  const render = (items: readonly { text: string }[]) =>
    `<system-reminder>\n${items.map((item) => item.text).join('\n\n')}\n</system-reminder>`
  const selected = [...changes]
  while (selected.length > 1 && byteLength(render(selected)) > maxBytes) selected.shift()
  if (selected.length === 0) return { text: '', state: [...previous.values()] }
  if (byteLength(render(selected)) > maxBytes) {
    const change = selected[0]!
    const original = change.source
    if (!original || !change.heading) return { text: '', state: [...previous.values()] }
    const heading = `${change.heading}\n\nWorkspace instruction budget: this file was truncated.`
    const sourceBytes = Buffer.from(original.content, 'utf8')
    let low = 0
    let high = sourceBytes.length
    let best: string | undefined
    let bestContent = ''
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2)
      const content = utf8Prefix(sourceBytes, midpoint)
      const text = render([{ text: renderSource({ ...original, content }, heading) }])
      if (byteLength(text) <= maxBytes) {
        best = text
        bestContent = content
        low = midpoint + 1
      } else high = midpoint - 1
    }
    if (best === undefined) return { text: '', state: [...previous.values()] }
    return {
      text: best,
      state: [...previous.values()]
        .filter((source) => source.path !== original.path)
        .concat({ ...original, content: bestContent })
    }
  }
  const state = new Map(previous)
  for (const change of selected) {
    if (change.remove) state.delete(change.remove)
    else if (change.source) state.set(change.source.path, change.source)
  }
  return { text: render(selected), state: [...state.values()] }
}

/** Loads workspace and user-global AGENTS-compatible instructions as durable context. */
export function createAgentInstructionsContext(
  fs: FileSystemService,
  config: AgentInstructionsConfig = {}
): ContextProvider {
  const maxBytes = config.maxBytes ?? 65_536
  const maxSourceBytes = config.maxSourceBytes ?? 1_048_576
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive safe integer')
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0)
    throw new RangeError('maxSourceBytes must be a positive safe integer')
  const markers = config.projectRootMarkers ?? ['.git']
  const baseFiles = config.instructionFileCandidates ?? DEFAULT_FILES
  const overlays = config.localInstructionFileCandidates ?? DEFAULT_LOCAL_FILES
  const globals = config.userGlobalPaths ?? DEFAULT_GLOBALS
  return async (input, options) => {
    options.signal?.throwIfAborted()
    const cwdValue =
      typeof config.cwd === 'function' ? await config.cwd(options.request) : (config.cwd ?? process.cwd())
    options.signal?.throwIfAborted()
    const cwd = resolve(cwdValue)
    const root = await projectRoot(fs, cwd, markers, options)
    const dirs = directoryChain(root, cwd)
    const previous = readState(input.messages)
    for (const touched of parseSuccessfulTouches(input)) {
      const absolute = isAbsolute(touched) ? resolve(touched) : resolve(cwd, touched)
      const rel = relative(cwd, dirname(absolute))
      if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
      let current = cwd
      for (const segment of rel.split(sep)) {
        current = join(current, segment)
        if (fs.contains(root, current) && !dirs.includes(current)) dirs.push(current)
      }
    }
    dirs.sort((left, right) =>
      left === right ? 0 : left.startsWith(`${right}${sep}`) ? 1 : right.startsWith(`${left}${sep}`) ? -1 : 0
    )
    const sources: Source[] = []
    const oversized: string[] = []
    const seenContent = new Map<string, Set<string>>()
    const load = async (path: string, display: string, scope: string, group: string) => {
      const loaded = await readInstruction(fs, path, maxSourceBytes, options)
      if (!loaded) return
      const groupContent = seenContent.get(group) ?? new Set<string>()
      if (loaded.oversized) {
        oversized.push(display)
        const old = previous.get(path)
        if (old && !groupContent.has(old.content)) {
          groupContent.add(old.content)
          seenContent.set(group, groupContent)
          sources.push(old)
        }
        return
      }
      if (groupContent.has(loaded.content)) return
      groupContent.add(loaded.content)
      seenContent.set(group, groupContent)
      sources.push({
        path,
        display,
        scope,
        content: loaded.content,
        digest: createHash('sha256').update(loaded.content).digest('hex')
      })
    }
    for (const globalPath of globals)
      await load(join(globalPath, 'AGENTS.md'), `${globalPath}/AGENTS.md`, 'user-global', 'user-global')
    for (const dir of dirs) {
      const scope = relative(root, dir) || '.'
      for (const name of baseFiles)
        await load(join(dir, name), [scope === '.' ? '' : scope, name].filter(Boolean).join('/'), scope, scope)
      for (const name of overlays)
        await load(join(dir, name), [scope === '.' ? '' : scope, name].filter(Boolean).join('/'), scope, scope)
    }
    options.signal?.throwIfAborted()
    const rendered = previous.size
      ? changeText(sources, previous, maxBytes)
      : baselineText(sources, maxBytes, oversized)
    if (!rendered.text) return input
    return appendContext(input, stateKey(rendered.state), rendered.text)
  }
}
