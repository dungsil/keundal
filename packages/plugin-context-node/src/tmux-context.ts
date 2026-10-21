import { execFile as nodeExecFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

import { appendContext, latestContextMessage } from '@keundal/context'
import type { ContextOptions, ContextProvider } from '@keundal/context'
import type { RunAgentInput } from '@keundal/core'

export interface TmuxContextConfig {
  /** Probe timeout in milliseconds; defaults to 1500. */
  readonly timeoutMs?: number
  /** Process environment containing TMUX and TMUX_PANE. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Injectable execFile-compatible runner; receives timeout and abort signal. */
  readonly runner?: (
    command: string,
    args: readonly string[],
    options: { readonly timeout: number; readonly signal?: AbortSignal }
  ) => Promise<string>
  /** Wall-clock milliseconds for durable scheduling. */
  readonly now?: () => number
  /** Minimum delay between updates; defaults to zero. */
  readonly refreshIntervalMs?: number
}

const KEY = 'tmux'
const FORMAT = [
  '#{session_name}',
  '#{window_index}',
  '#{window_name}',
  '#{pane_index}',
  '#{pane_id}',
  '#{window_active}',
  '#{pane_active}',
  '#{window_layout}'
].join('\\t')
const execFile = promisify(nodeExecFile)

async function runTmux(
  command: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly signal?: AbortSignal }
): Promise<string> {
  const result = await execFile(command, [...args], {
    encoding: 'utf8',
    timeout: options.timeout,
    signal: options.signal
  })
  return result.stdout
}

export function createTmuxContext(config: TmuxContextConfig = {}): ContextProvider {
  const interval = config.refreshIntervalMs ?? 0
  if (!Number.isSafeInteger(interval) || interval < 0)
    throw new TypeError('refreshIntervalMs must be a non-negative safe integer')
  const timeout = config.timeoutMs ?? 1_500
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('timeoutMs must be a positive safe integer')
  const env = config.env ?? process.env
  const now = config.now ?? Date.now
  const runner = config.runner ?? runTmux
  return async (input: RunAgentInput, options: ContextOptions) => {
    options.signal?.throwIfAborted()
    if (options.step !== 1) return input
    const pane = env.TMUX_PANE
    if (!pane || !env.TMUX) return input
    const previous = latestContextMessage(input, KEY)?.content
    const previousEpoch = previous?.match(/epoch milliseconds: (\d+)/)?.[1]
    const sampledAt = now()
    if (
      interval > 0 &&
      previousEpoch !== undefined &&
      sampledAt >= Number(previousEpoch) &&
      sampledAt - Number(previousEpoch) < interval
    )
      return input
    try {
      const paneTty = (
        await runner('tmux', ['display-message', '-p', '-t', pane, '#{pane_tty}'], { timeout, signal: options.signal })
      ).trim()
      options.signal?.throwIfAborted()
      const selfTty = (
        await runner('ps', ['-o', 'tty=', '-p', String(process.pid)], { timeout, signal: options.signal })
      ).trim()
      options.signal?.throwIfAborted()
      if (!paneTty || !selfTty || paneTty !== `/dev/${selfTty}`) return input
      const output = await runner('tmux', ['display-message', '-p', '-t', pane, FORMAT], {
        timeout,
        signal: options.signal
      })
      options.signal?.throwIfAborted()
      const fields = output.trimEnd().split('\\t')
      if (fields.length !== 8 || fields[4] === '') return input
      const [session, window, windowName, paneIndex, paneId, windowActive, paneActive, layout] = fields
      const state = `session ${session}, window ${window} ${JSON.stringify(windowName)}, pane ${paneIndex} ${paneId}\nwindow active=${windowActive}, pane active=${paneActive}, layout ${layout}`
      const priorState = previous?.split('\nepoch milliseconds: ', 1)[0]?.split('\n').slice(1).join('\n')
      if (priorState === state) return input
      return appendContext(
        input,
        KEY,
        `tmux location (turn step ${options.step}):\n${state}\nepoch milliseconds: ${sampledAt}`
      )
    } catch {
      options.signal?.throwIfAborted()
      return input
    }
  }
}
