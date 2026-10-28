import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** Operator-owned permissions. Tool Approval never changes this policy. */
export interface SandboxPolicy {
  readonly workspace: string
  readonly readOnlyPaths?: readonly string[]
  readonly writablePaths?: readonly string[]
  /** Exact host:port destinations, not URL patterns or suffix matches. */
  readonly allowedHosts?: readonly string[]
  /** Additional environment explicitly entrusted to every plugin in the host. */
  readonly environment?: Readonly<Record<string, string>>
}

export interface SandboxProcessRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly policy: SandboxPolicy
  readonly environment: Readonly<Record<string, string>>
  /** Trusted parent installation and policy; writable grants must not overlap these paths. */
  readonly protectedPaths?: readonly string[]
  readonly mounts: readonly { source: string; target: string; writable: boolean }[]
}

/** Providers must isolate filesystem, network and host processes before executing any application code. */
export interface SandboxProvider {
  /** Includes cold guest boot and file import, not model execution. */
  readonly startupTimeoutMs?: number
  start(request: SandboxProcessRequest): ChildProcessWithoutNullStreams
  /** Gracefully persists and exports guest state; rejects when export cannot complete safely. */
  stop?(child: ChildProcessWithoutNullStreams): Promise<void>
}
