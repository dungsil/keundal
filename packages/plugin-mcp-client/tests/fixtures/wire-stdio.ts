import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const phase = process.argv[2]
const payload = 'WIRE_PAYLOAD'.repeat(180000)
appendFileSync(process.argv[3]!, `${process.pid}\n`)
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (!('id' in request)) return
  if (
    (phase === 'probe' && request.method === 'server/discover') ||
    (phase !== 'probe' && request.method === 'initialize')
  ) {
    if (phase === 'notification')
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: payload } }) + '\n'
      )
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: payload, version: '1' } }
      }) + '\n'
    )
  } else if (request.method === 'initialize')
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
      }) + '\n'
    )
  else
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'
    )
})
