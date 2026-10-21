import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'

import type { Transport } from '@modelcontextprotocol/client'

const MAX_CATALOG_TOOLS = 256
const MAX_CATALOG_BYTES = 1024 * 1024
const MAX_DEFINITION_BYTES = 64 * 1024
const MAX_DESCRIPTION_BYTES = 16 * 1024
const MAX_DEPTH = 32

function fail(): never {
  throw new Error('MCP tool catalog exceeds size, count or depth limits')
}

// Walk decoded JSON with bounded depth and stop before allocating a serialized catalog.
function jsonBytes(value: unknown, limit: number): number {
  let bytes = 0
  const add = (size: number) => {
    bytes += size
    if (bytes > limit) fail()
  }
  const string = (text: string) => {
    if (text.length > limit - bytes) fail()
    add(Buffer.byteLength(JSON.stringify(text)))
  }
  const visit = (item: unknown, depth: number) => {
    if (depth > MAX_DEPTH) fail()
    if (typeof item === 'string') return string(item)
    if (item === null || typeof item !== 'object') {
      add(typeof item === 'number' ? String(item).length : item === true ? 4 : 5)
      return
    }
    add(2)
    let first = true
    if (Array.isArray(item)) {
      for (const child of item) {
        if (!first) add(1)
        first = false
        visit(child, depth + 1)
      }
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue
        if (!first) add(1)
        first = false
        string(key)
        add(1)
        visit((item as Record<string, unknown>)[key], depth + 1)
      }
    }
  }
  visit(value, 0)
  return bytes
}

class CatalogBudget {
  private bytes = 0
  private tools = 0

  consume(result: unknown) {
    this.bytes += jsonBytes(result, MAX_CATALOG_BYTES - this.bytes)
    if (typeof result !== 'object' || result === null || !('tools' in result) || !Array.isArray(result.tools)) return
    this.tools += result.tools.length
    if (this.tools > MAX_CATALOG_TOOLS) fail()
    for (const definition of result.tools) {
      jsonBytes(definition, MAX_DEFINITION_BYTES)
      if (typeof definition?.description === 'string') {
        if (
          definition.description.length > MAX_DESCRIPTION_BYTES ||
          Buffer.byteLength(definition.description) > MAX_DESCRIPTION_BYTES
        )
          fail()
      }
    }
  }
}

/** Guard decoded pages before SDK validation, pagination accumulation and caching. */
export class CatalogDiscovery {
  private readonly active = new AsyncLocalStorage<CatalogBudget>()
  private readonly pending = new Map<number, CatalogBudget>()

  constructor(transport: Transport) {
    const send = transport.send.bind(transport)
    transport.send = async (message, options) => {
      if ('method' in message && message.method === 'tools/list' && 'id' in message) {
        const budget = this.active.getStore()
        if (budget) this.pending.set(Number(message.id), budget)
      }
      await send(message, options)
    }
    const onmessage = transport.onmessage
    transport.onmessage = (message, extra) => {
      if ('id' in message && message.id !== undefined && ('result' in message || 'error' in message)) {
        // Match the SDK response dispatcher, which normalizes IDs with Number().
        const budget = this.pending.get(Number(message.id))
        this.pending.delete(Number(message.id))
        if (budget && 'result' in message) {
          try {
            budget.consume(message.result)
          } catch {
            onmessage?.(
              {
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32603, message: 'MCP tool catalog exceeds size, count or depth limits' }
              },
              extra
            )
            return
          }
        }
      }
      onmessage?.(message, extra)
    }
  }

  async run<T>(discover: () => Promise<T>): Promise<T> {
    const budget = new CatalogBudget()
    try {
      return await this.active.run(budget, discover)
    } finally {
      for (const [id, owner] of this.pending) {
        if (owner === budget) this.pending.delete(id)
      }
    }
  }
}
