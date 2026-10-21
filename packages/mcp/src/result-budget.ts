import { AsyncLocalStorage } from 'node:async_hooks'

import type { Transport } from '@modelcontextprotocol/client'

export const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024
const MAX_RESULT_DEPTH = 64

const exceeded = () => new Error('MCP result exceeds the configured size or nesting limit')

/** JSON 문자열을 만들기 전에 UTF-8 직렬화 크기를 계산하고 한도를 넘는 즉시 중단합니다. */
export function resultBytes(value: unknown, limit: number): number {
  let bytes = 0
  const add = (size: number) => {
    bytes += size
    if (bytes > limit) throw exceeded()
  }
  const string = (value: string) => {
    add(2)
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2)
      else if (code < 32) add(6)
      else if (code < 128) add(1)
      else if (code < 2048) add(2)
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4)
          index++
        } else add(6)
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6)
      else add(3)
    }
  }
  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_RESULT_DEPTH) throw exceeded()
    if (value === null || value === undefined) add(4)
    else if (typeof value === 'string') string(value)
    else if (typeof value === 'boolean') add(value ? 4 : 5)
    else if (typeof value === 'number') add(Number.isFinite(value) ? String(value).length : 4)
    else if (Array.isArray(value)) {
      add(2)
      for (let index = 0; index < value.length; index++) {
        if (index) add(1)
        visit(value[index], depth + 1)
      }
    } else if (typeof value === 'object') {
      add(2)
      let first = true
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        const entry = (value as Record<string, unknown>)[key]
        if (entry === undefined) continue
        if (!first) add(1)
        first = false
        string(key)
        add(1)
        visit(entry, depth + 1)
      }
    } else throw new Error('MCP result is not JSON data')
  }
  visit(value, 0)
  return bytes
}

/** SDK가 전달한 원격 오류도 큰 본문이나 data를 후속 오류 응답에 보존하지 않습니다. */
export async function boundedMcpRequest<T>(operation: () => Promise<T>, limit: number): Promise<T> {
  try {
    const result = await operation()
    resultBytes(result, limit)
    return result
  } catch (error) {
    if (error instanceof Error) {
      resultBytes({ message: error.message, data: 'data' in error ? error.data : undefined }, limit)
    } else resultBytes(error, limit)
    throw error
  }
}

/** 각 페이지를 검사한 뒤에만 합치며 SDK의 무제한 응답 캐시 복사를 피합니다. */
export async function boundedMcpPages<T extends { nextCursor?: string }, Item>(
  fetch: (cursor: string | undefined) => Promise<T>,
  items: (page: T) => Item[],
  limit: number
): Promise<{ first: T; items: Item[] }> {
  const all: Item[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  let first: T | undefined
  let remaining = limit
  for (let index = 0; index < 64; index++) {
    const page = await boundedMcpRequest(() => fetch(cursor), remaining)
    remaining -= resultBytes(page, remaining)
    first ??= page
    for (const item of items(page)) all.push(item)
    if (page.nextCursor === undefined) return { first, items: all }
    if (cursors.has(page.nextCursor)) throw new Error('MCP resource pagination repeated a cursor')
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new Error('MCP resource pagination exceeds the page limit')
}

/** SDK가 결과 검증이나 오류 변환을 수행하기 전에 해석된 응답의 크기를 제한합니다. */
export class McpResultBudget {
  private readonly active = new AsyncLocalStorage<Set<number>>()
  private readonly pending = new Map<number, Set<number>>()

  constructor(
    transport: Transport,
    private readonly limit: number
  ) {
    const send = transport.send.bind(transport)
    transport.send = async (message, options) => {
      if ('id' in message && 'method' in message) {
        const requests = this.active.getStore()
        if (requests) {
          requests.add(Number(message.id))
          this.pending.set(Number(message.id), requests)
        }
      }
      await send(message, options)
    }
    const onmessage = transport.onmessage
    transport.onmessage = (message, extra) => {
      if ('id' in message && message.id !== undefined && ('result' in message || 'error' in message)) {
        // SDK는 만료되거나 중복된 응답도 오류 문자열로 직렬화하므로 전체 봉투를 먼저 제한합니다.
        try {
          resultBytes(message, 2 * Math.max(DEFAULT_MAX_RESULT_BYTES, this.limit))
        } catch {
          const id =
            typeof message.id === 'number' ? message.id : message.id.length <= 128 ? Number(message.id) : undefined
          if (id !== undefined && this.pending.has(id)) {
            const requests = this.pending.get(id)
            this.pending.delete(id)
            requests?.delete(id)
            onmessage?.({ jsonrpc: '2.0', id, error: { code: -32603, message: exceeded().message } }, extra)
          }
          return
        }
        const requests = this.pending.get(Number(message.id))
        this.pending.delete(Number(message.id))
        requests?.delete(Number(message.id))
        if (requests) {
          try {
            if ('result' in message) resultBytes(message.result, this.limit)
            if ('error' in message) resultBytes(message.error, this.limit)
          } catch {
            onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: exceeded().message } }, extra)
            return
          }
        }
      }
      onmessage?.(message, extra)
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const requests = new Set<number>()
    try {
      return await this.active.run(requests, () => boundedMcpRequest(operation, this.limit))
    } finally {
      for (const id of requests) this.pending.delete(id)
    }
  }
}
