import type { ShellRequest } from '@keundal/shell'
import type { ExecutableTool } from '@keundal/tools'
import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    readonly shellTools: ShellToolsService
  }
}

function parseArgs(args: Record<string, unknown>): ShellRequest {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !['command', 'cwd', 'timeoutMs'].includes(key)) ||
    typeof args.command !== 'string' ||
    !args.command.trim() ||
    args.command.includes('\0') ||
    (args.cwd !== undefined && (typeof args.cwd !== 'string' || !args.cwd.trim() || args.cwd.includes('\0'))) ||
    (args.timeoutMs !== undefined &&
      (typeof args.timeoutMs !== 'number' ||
        !Number.isSafeInteger(args.timeoutMs) ||
        args.timeoutMs <= 0 ||
        args.timeoutMs > 2147483647))
  ) {
    throw new TypeError('invalid shell arguments')
  }
  return {
    command: args.command,
    ...(args.cwd === undefined ? {} : { cwd: args.cwd as string }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs as number })
  }
}

export class ShellToolsService extends Service {
  readonly tools: readonly ExecutableTool[]

  constructor(ctx: Context) {
    super(ctx, 'shellTools')
    this.tools = Object.freeze([
      Object.freeze({
        name: 'shell',
        description: 'Execute a foreground shell command in the configured working directory.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', minLength: 1 },
            cwd: { type: 'string', minLength: 1 },
            timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647 }
          },
          required: ['command'],
          additionalProperties: false
        },
        execute: async (args, context) =>
          JSON.stringify(await ctx.shell.execute(parseArgs(args), { signal: context.signal }))
      } satisfies ExecutableTool)
    ])
  }
}

export const shellToolsPlugin = Object.assign(
  function shellToolsPlugin(ctx: Context) {
    new ShellToolsService(ctx)
  },
  { inject: ['shell'] }
)

export default shellToolsPlugin
