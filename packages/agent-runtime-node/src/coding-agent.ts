import codingAgentPlugin from '@keundal/plugin-agent-coding'
import { LocalFileSystemService } from '@keundal/plugin-fs-local'
import { PolicyFileSystemService } from '@keundal/plugin-fs-policy'
import { FileSystemToolsService } from '@keundal/plugin-tool-fs'
import { createTodoTools } from '@keundal/plugin-tool-todo'
import type { ExecutableTool } from '@keundal/tools'
import type { Context } from 'cordis'

import type { HostComposition, NodeHostOptions } from './index.js'

/** Coding-specific filesystem policy stays out of general chat and provider assembly. */
export async function mountCodingAgent(
  ctx: Context,
  config: Parameters<HostComposition['mountAgent']>[1],
  options: Pick<NodeHostOptions, 'maxToolRounds' | 'bundledPlugins'>
) {
  const backendContext = ctx.isolate('fs')
  let backend!: LocalFileSystemService
  await backendContext.plugin((child: Context) => {
    backend = new LocalFileSystemService(child, { cwd: config.workspacePath })
  })
  const files = ctx.isolate('fs')
  await files.plugin((child: Context) => {
    new PolicyFileSystemService(child, {
      backend,
      roots: [config.workspacePath!],
      writableRoots: [config.workspacePath!]
    })
  })
  let tools!: readonly ExecutableTool[]
  await files.plugin(
    Object.assign(
      (child: Context) => {
        tools = new FileSystemToolsService(child).tools.map((tool) => ({
          ...tool,
          async execute(args, execution) {
            const path = args.path
            if (typeof path !== 'string' || path.split(/[\\/]/).some((part) => part.toLowerCase() === '.git'))
              throw new Error('Git metadata is not accessible to file tools')
            const canonical = await child.fs.resolve(path, { signal: execution.signal })
            if (canonical.split(/[\\/]/).some((part) => part.toLowerCase() === '.git'))
              throw new Error('Git metadata is not accessible to file tools')
            return tool.execute(args, execution)
          }
        }))
      },
      { inject: ['fs'] }
    )
  )
  const { codingThreadId: _thread, workspacePath: _path, ...agentConfig } = config
  return files.plugin(codingAgentPlugin, {
    ...agentConfig,
    maxToolRounds: options.maxToolRounds ?? 8,
    skills: false,
    promptPresets: false,
    subagents: false,
    tools: [...tools, ...(options.bundledPlugins?.['@keundal/plugin-tool-todo'] !== false ? createTodoTools() : [])]
  })
}
