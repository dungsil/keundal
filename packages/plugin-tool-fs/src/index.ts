import type { FileSystemOptions } from '@keundal/fs'
import type { ExecutableTool } from '@keundal/tools'
import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    readonly fsTools: FileSystemToolsService
  }
}

function strings(args: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof args[key] !== 'string') ||
    !(args.path as string).trim() ||
    (args.path as string).includes('\0')
  )
    throw new Error('invalid file tool arguments')
  return args as Record<string, string>
}

export class FileSystemToolsService extends Service {
  readonly tools: readonly ExecutableTool[]

  constructor(ctx: Context) {
    super(ctx, 'fsTools')
    const definitions = [
      {
        name: 'read_file',
        description: 'Read a UTF-8 file before modifying it.',
        keys: ['path'],
        run: (args, options) => ctx.fs.read(args.path!, options)
      },
      {
        name: 'list_directory',
        description: 'List immediate directory entries without following symlinks.',
        keys: ['path'],
        run: (args, options) => ctx.fs.list(args.path!, options)
      },
      {
        name: 'write_file',
        description: 'Create a UTF-8 file or replace a previously read file. Existing parents are required.',
        keys: ['path', 'content'],
        run: (args, options) => ctx.fs.write(args.path!, args.content!, options)
      },
      {
        name: 'edit_file',
        description: 'Replace exactly one occurrence of oldText in a previously read file.',
        keys: ['path', 'oldText', 'newText'],
        run: (args, options) => ctx.fs.edit(args.path!, { oldText: args.oldText!, newText: args.newText! }, options)
      }
    ] satisfies {
      name: string
      description: string
      keys: string[]
      run: (args: Record<string, string>, options: FileSystemOptions) => Promise<unknown>
    }[]
    this.tools = Object.freeze(
      definitions.map(({ name, description, keys, run }): ExecutableTool =>
        Object.freeze<ExecutableTool>({
          name,
          description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
            required: keys,
            additionalProperties: false
          },
          describeOperation: (args) => ({ kind: name, paths: [strings(args, keys).path!] }),
          execute: async (args, context) =>
            JSON.stringify(await run(strings(args, keys), { signal: context.signal, scope: context.threadId }))
        })
      )
    )
  }
}

export const fileSystemToolsPlugin = Object.assign(
  function fileSystemToolsPlugin(ctx: Context) {
    new FileSystemToolsService(ctx)
  },
  { inject: ['fs'] }
)

export default fileSystemToolsPlugin
