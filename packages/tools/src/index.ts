import type { AgentTool, ExecutionOptions, TraceSpan } from '@keundal/core'

export const TOOL_PROGRESS_EVENT = 'keundal.tool.progress'

export interface ToolExecutionContext {
  readonly threadId: string
  readonly runId: string
  readonly toolCallId: string
  readonly reportProgress?: (value: unknown) => void
  readonly reportTrace?: (span: TraceSpan) => void
  readonly traceId?: string
  readonly parentSpanId?: string
  readonly signal: AbortSignal
}

export interface ExecutableTool extends AgentTool {
  /** JSON 객체 인자를 검증하고 실행하여 도구 결과 문자열을 반환합니다. */
  readonly execute: (args: Record<string, unknown>, context: ToolExecutionContext) => string | Promise<string>
}

export type ToolProvider = (options: ExecutionOptions) => readonly ExecutableTool[] | Promise<readonly ExecutableTool[]>

export interface DeferredToolsConfig {
  readonly maxSearchResults?: number
  readonly maxActiveTools?: number
  readonly maxSchemaBytes?: number
  readonly maxTotalSchemaBytes?: number
}

export interface ResolvedDeferredToolsConfig {
  readonly maxSearchResults: number
  readonly maxActiveTools: number
  readonly maxSchemaBytes: number
  readonly maxTotalSchemaBytes: number
}

export interface DeferredToolSession {
  readonly searchTool: ExecutableTool
  readonly activeTools: readonly ExecutableTool[]
  refresh(): Promise<void>
}

const DEFAULT_DEFERRED_CONFIG: ResolvedDeferredToolsConfig = {
  maxSearchResults: 8,
  maxActiveTools: 16,
  maxSchemaBytes: 16_384,
  maxTotalSchemaBytes: 65_536
}

const schemaEncoder = new globalThis.TextEncoder()

export function parseDeferredToolsConfig(value: unknown): ResolvedDeferredToolsConfig {
  if (value === undefined) return { ...DEFAULT_DEFERRED_CONFIG }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('deferredTools must be an object')
  }
  const config = value as Record<string, unknown>
  const resolved = { ...DEFAULT_DEFERRED_CONFIG }
  for (const key of Object.keys(resolved) as (keyof ResolvedDeferredToolsConfig)[]) {
    const entry = config[key]
    if (entry !== undefined) {
      if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry <= 0) {
        throw new Error(`deferredTools.${key} must be a positive integer`)
      }
      resolved[key] = entry
    }
  }
  if (resolved.maxSchemaBytes > resolved.maxTotalSchemaBytes) {
    throw new Error('deferredTools.maxSchemaBytes must not exceed maxTotalSchemaBytes')
  }
  return resolved
}
/** 검색으로 선택하기 전에는 도구를 실행할 수 없도록 제한된 실행별 카탈로그를 만듭니다. */
export async function createDeferredToolSession(
  provider: ToolProvider,
  options: ExecutionOptions,
  config?: DeferredToolsConfig
): Promise<DeferredToolSession> {
  const limits = parseDeferredToolsConfig(config)
  let catalog = await readCatalog(provider, options)
  const active = new Map<string, { tool: ExecutableTool; fingerprint: string }>()

  const refresh = async () => {
    options.signal?.throwIfAborted()
    const refreshed = await readCatalog(provider, options)
    const currentByName = new Map(refreshed.map((tool) => [tool.name, tool]))
    for (const [name, selected] of active) {
      const current = currentByName.get(name)
      if (!current || toolFingerprint(current) !== selected.fingerprint) active.delete(name)
      else active.set(name, { tool: snapshotTool(current), fingerprint: selected.fingerprint })
    }
    catalog = refreshed
  }

  const search = async (query: string) => {
    if (typeof query !== 'string' || !query.trim()) throw new Error('search_tool query must be a non-empty string')
    await refresh()
    const terms = query.toLowerCase().split(/\s+/u).filter(Boolean)
    const matches = catalog
      .filter((tool) => terms.some((term) => `${tool.name} ${tool.description}`.toLowerCase().includes(term)))
      .slice(0, limits.maxSearchResults)
    let totalBytes = [...active.values()].reduce((sum, entry) => sum + schemaBytes(entry.tool.parameters), 0)
    const results: { name: string; description: string }[] = []
    for (const tool of matches) {
      const bytes = schemaBytes(tool.parameters)
      const fingerprint = toolFingerprint(tool)
      if (!active.has(tool.name)) {
        if (
          active.size >= limits.maxActiveTools ||
          bytes > limits.maxSchemaBytes ||
          totalBytes + bytes > limits.maxTotalSchemaBytes
        )
          continue
        active.set(tool.name, { tool: snapshotTool(tool), fingerprint })
        totalBytes += bytes
      }
      if (active.has(tool.name)) results.push({ name: tool.name, description: tool.description })
    }
    return results
  }

  const searchTool: ExecutableTool = {
    name: 'search_tool',
    description:
      'Search the authorized deferred tool catalog by name or description. Selected tools become available on the next request.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Tool name or capability to find' } },
      required: ['query'],
      additionalProperties: false
    },
    execute: async (args) => JSON.stringify(await search(typeof args.query === 'string' ? args.query : ''))
  }

  return {
    searchTool,
    get activeTools() {
      return [...active.values()].map(({ tool, fingerprint }) => ({
        ...tool,
        execute: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
          context.signal.throwIfAborted()
          const current = await readCatalog(provider, { signal: context.signal })
          const match = current.find((candidate) => candidate.name === tool.name)
          if (!match || toolFingerprint(match) !== fingerprint) {
            throw new Error(`deferred tool is no longer authorized: ${tool.name}`)
          }
          return match.execute(args, context)
        }
      }))
    },
    refresh
  }
}

async function readCatalog(provider: ToolProvider, options: ExecutionOptions): Promise<ExecutableTool[]> {
  const tools = await provider(options)
  const names = new Set<string>()
  return tools.map((tool) => {
    if (
      !tool ||
      typeof tool.name !== 'string' ||
      !tool.name.trim() ||
      typeof tool.description !== 'string' ||
      typeof tool.execute !== 'function' ||
      typeof tool.parameters !== 'object' ||
      tool.parameters === null
    ) {
      throw new Error('deferred tool provider returned an invalid tool')
    }
    if (tool.name === 'search_tool') throw new Error('deferred tool name is reserved: search_tool')
    if (names.has(tool.name)) throw new Error(`duplicate deferred tool name: ${tool.name}`)
    names.add(tool.name)
    return tool
  })
}

function schemaBytes(parameters: AgentTool['parameters']): number {
  return schemaEncoder.encode(JSON.stringify(parameters)).byteLength
}

function toolFingerprint(tool: ExecutableTool): string {
  return JSON.stringify([tool.name, tool.description, tool.parameters])
}
function snapshotTool(tool: ExecutableTool): ExecutableTool {
  return { ...tool, parameters: JSON.parse(JSON.stringify(tool.parameters)) }
}
