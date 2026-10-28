import type { ExecutableTool } from '@keundal/tools'
import type { WorkspaceOptions } from '@keundal/workspace'
import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    readonly workspaceTools: WorkspaceToolsService
  }
}

function validate(args: Record<string, unknown>, keys: readonly string[], required: readonly string[]): void {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !keys.includes(key)) ||
    required.some((key) => args[key] === undefined) ||
    Object.entries(args).some(([key, value]) =>
      key === 'staged' ? typeof value !== 'boolean' : typeof value !== 'string' || !value.trim() || value.includes('\0')
    )
  )
    throw new TypeError('invalid workspace tool arguments')
}

export class WorkspaceToolsService extends Service {
  readonly tools: readonly ExecutableTool[]

  constructor(ctx: Context) {
    super(ctx, 'workspaceTools')
    const definitions = [
      {
        name: 'git_status',
        description: 'List staged, unstaged and untracked files in the workspace.',
        keys: ['taskId'],
        required: [],
        run: (_args, options) => ctx.workspace.status(options)
      },
      {
        name: 'git_diff',
        description: 'Read a tracked-file diff. Set staged to inspect the index instead.',
        keys: ['taskId', 'staged'],
        required: [],
        run: (args, options) => ctx.workspace.diff({ ...options, staged: args.staged as boolean | undefined })
      },
      {
        name: 'git_apply_patch',
        description: 'Submit a Git patch for user review before applying it without staging.',
        keys: ['taskId', 'patch'],
        required: ['patch'],
        run: async (args, options) => {
          await ctx.workspace.applyPatch(args.patch as string, options)
          return { applied: true }
        }
      },
      {
        name: 'git_create_worktree',
        description:
          'Request a detached task worktree at the current committed HEAD. Does not copy uncommitted changes.',
        keys: ['taskId'],
        required: ['taskId'],
        run: (args, options) => ctx.workspace.createWorktree(args.taskId as string, options)
      },
      {
        name: 'git_remove_worktree',
        description: 'Request removal of a clean task worktree. Never force-deletes changes.',
        keys: ['taskId'],
        required: ['taskId'],
        run: async (args, options) => {
          await ctx.workspace.removeWorktree(args.taskId as string, options)
          return { removed: true }
        }
      }
    ] satisfies {
      name: string
      description: string
      keys: string[]
      required: string[]
      run: (args: Record<string, unknown>, options: WorkspaceOptions) => Promise<unknown>
    }[]
    this.tools = Object.freeze(
      definitions.map(({ name, description, keys, required, run }): ExecutableTool =>
        Object.freeze<ExecutableTool>({
          name,
          description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(keys.map((key) => [key, { type: key === 'staged' ? 'boolean' : 'string' }])),
            required,
            additionalProperties: false
          },
          execute: async (args, context) => {
            validate(args, keys, required)
            return JSON.stringify(
              await run(args, { signal: context.signal, taskId: args.taskId as string | undefined })
            )
          }
        })
      )
    )
  }
}

export const workspaceToolsPlugin = Object.assign(
  function workspaceToolsPlugin(ctx: Context) {
    new WorkspaceToolsService(ctx)
  },
  { inject: ['workspace'] }
)

export default workspaceToolsPlugin
