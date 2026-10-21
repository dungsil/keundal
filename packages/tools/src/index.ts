import type { AgentTool, ExecutionOptions } from '@keundal/core'

export interface ToolExecutionContext {
  readonly threadId: string
  readonly runId: string
  readonly toolCallId: string
  readonly signal: AbortSignal
}

export interface ExecutableTool extends AgentTool {
  /** JSON 객체 인자를 검증하고 실행하여 도구 결과 문자열을 반환합니다. */
  readonly execute: (args: Record<string, unknown>, context: ToolExecutionContext) => string | Promise<string>
}

export type ToolProvider = (options: ExecutionOptions) => readonly ExecutableTool[] | Promise<readonly ExecutableTool[]>
