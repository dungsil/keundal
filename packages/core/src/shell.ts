import { Service, type Context } from 'cordis'

import type { ExecutionOptions } from './execution.js'

export interface ShellRequest {
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface ShellResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly truncated: boolean
}

export abstract class ShellService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  /** 비정상 종료는 결과로 반환하고, 실행 준비 오류는 예외로 전달합니다. */
  abstract execute(request: ShellRequest, options?: ExecutionOptions): Promise<ShellResult>
}
