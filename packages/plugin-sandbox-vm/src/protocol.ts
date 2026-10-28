import type { Readable, Writable } from 'node:stream'

/** Bounded, backpressured serial transport. No guest message contains a host pathname to open. */
export class LineChannel {
  readonly frames: AsyncIterable<Record<string, unknown>>
  private pending = Promise.resolve()

  constructor(
    readable: Readable,
    private readonly writable: Writable
  ) {
    writable.on('error', (error) => readable.destroy(error))
    this.frames = this.read(readable)
  }

  private async *read(readable: Readable): AsyncGenerator<Record<string, unknown>> {
    const { Buffer } = globalThis.process.getBuiltinModule('node:buffer')
    let buffered = Buffer.alloc(0)
    for await (const chunk of readable) {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)])
      let newline: number
      while ((newline = buffered.indexOf(10)) !== -1) {
        if (newline > 16 * 1024 * 1024) throw new Error('VM frame exceeds limit')
        const frame: unknown = JSON.parse(buffered.subarray(0, newline).toString('utf8'))
        buffered = buffered.subarray(newline + 1)
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid VM frame')
        yield frame as Record<string, unknown>
      }
      if (buffered.length > 16 * 1024 * 1024) throw new Error('VM frame exceeds limit')
    }
    if (buffered.length) throw new Error('Truncated VM frame')
  }

  send(frame: Record<string, unknown>): Promise<void> {
    const { Buffer } = globalThis.process.getBuiltinModule('node:buffer')
    const data = JSON.stringify(frame) + '\n'
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) return Promise.reject(new Error('VM frame exceeds limit'))
    this.pending = this.pending.then(
      () =>
        new Promise<void>((resolve, reject) =>
          this.writable.write(data, (error) => (error ? reject(error) : resolve()))
        )
    )
    return this.pending
  }
}
