import { appendContext, latestContextMessage } from '@keundal/context'
import type { ContextOptions, ContextProvider } from '@keundal/context'
import type { RunAgentInput } from '@keundal/core'

export interface TimeContextConfig {
  /** Minimum milliseconds between readings; defaults to 10 minutes. */
  readonly refreshIntervalMs?: number
  /** Explicit fallback IANA zone; omitted uses process zone. Invalid values throw. */
  readonly timeZone?: string
  /**
   * Request browser-zone lookup. Without this callback, forwardedProps.browserTimeZone
   * may be a string or forwardedProps.browserTimeZones may be a string array.
   */
  readonly getBrowserTimeZones?: (request: RunAgentInput) => readonly string[] | undefined
  /** Clock seam for deterministic elapsed-time behavior. */
  readonly now?: () => number
}

const KEY = 'time'
const MARKER = 'Time sampled at epoch milliseconds: '
const DEFAULT_INTERVAL = 600_000

function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function zonesFromRequest(request: RunAgentInput): readonly string[] {
  const props = request.forwardedProps as Record<string, unknown> | undefined
  const one = props?.browserTimeZone
  const many = props?.browserTimeZones
  if (typeof one === 'string') return [one]
  if (Array.isArray(many)) return many.filter((zone): zone is string => typeof zone === 'string')
  return []
}

function stamp(now: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset'
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  const offset = part('timeZoneName').replace('GMT', '') || '+00:00'
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}[${zone}]`
}

function priorEpoch(input: RunAgentInput): number | undefined {
  const prior = latestContextMessage(input, KEY)?.content.match(new RegExp(`${MARKER}(\\d+)`))?.[1]
  return prior === undefined ? undefined : Number(prior)
}

export function createTimeContext(config: TimeContextConfig = {}): ContextProvider {
  const interval = config.refreshIntervalMs ?? DEFAULT_INTERVAL
  if (!Number.isSafeInteger(interval) || interval < 0)
    throw new TypeError('refreshIntervalMs must be a non-negative safe integer')
  if (config.timeZone !== undefined && !validZone(config.timeZone))
    throw new TypeError(`time-context: invalid IANA timeZone ${JSON.stringify(config.timeZone)}`)
  const fallback = config.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = config.now ?? Date.now
  return (input, options: ContextOptions) => {
    options.signal?.throwIfAborted()
    const previous = priorEpoch(input)
    const sampledAt = now()
    if (interval > 0 && previous !== undefined && sampledAt >= previous && sampledAt - previous < interval) return input
    const zones = config.getBrowserTimeZones?.(options.request) ?? zonesFromRequest(options.request)
    const unique = [...new Set(zones)]
    const requestZone = unique.length === 1 && validZone(unique[0]) ? unique[0] : undefined
    const zone = requestZone ?? fallback
    const policy = requestZone
      ? `Use browser time zone ${requestZone}.`
      : unique.length > 1
        ? 'Browser time zones are mixed; ask the user to clarify the intended zone.'
        : 'Browser time zone is unavailable; ask the user to clarify the intended zone.'
    // RunAgentInput has no durable event timestamps; the first sample cannot calculate a prior-message elapsed duration.
    const elapsed = previous === undefined ? 'unavailable' : `${Math.floor(Math.max(0, sampledAt - previous) / 1000)}s`
    const text = `${MARKER}${sampledAt}\nCurrent time: ${stamp(sampledAt, zone)}\n${policy}\nElapsed since the preceding time context: ${elapsed}.`
    return appendContext(input, KEY, text)
  }
}
