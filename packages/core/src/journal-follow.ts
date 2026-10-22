import type { GenerationJournalEntry } from './generation.js'

/**
 * 구독이 journal을 읽는 최소 표면입니다. read는 현재 시점의 journal과 종료 여부를 동기적으로
 * 돌려주고, listen은 새 기록과 종료를 알립니다. 종료 알림은 undefined로 전달합니다.
 */
export interface JournalSource {
  read():
    | { journal: readonly GenerationJournalEntry[]; done: boolean }
    | Promise<{ journal: readonly GenerationJournalEntry[]; done: boolean }>
  listen(listener: (entry: GenerationJournalEntry | undefined) => void): () => void
}

/**
 * 실행 중인 journal을 구독자에게 전달합니다. 저장소 구현이 기록을 추가할 때 publish하고, 실행이
 * 종료 상태로 확정되면 end를 호출해 기다리는 구독자를 깨웁니다. 종료 알림은 undefined로 전달합니다.
 */
export class JournalHub {
  private readonly listeners = new Map<string, Set<(entry: GenerationJournalEntry | undefined) => void>>()

  listen(runId: string, listener: (entry: GenerationJournalEntry | undefined) => void): () => void {
    const listeners = this.listeners.get(runId) ?? new Set()
    this.listeners.set(runId, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(runId)
    }
  }

  publish(runId: string, entry: GenerationJournalEntry): void {
    for (const listener of this.listeners.get(runId) ?? []) listener(entry)
  }

  end(runId: string): void {
    const listeners = this.listeners.get(runId)
    if (!listeners) return
    this.listeners.delete(runId)
    for (const listener of listeners) listener(undefined)
  }
}

/**
 * 저장된 journal을 afterSequence 다음부터 순서대로 전달하고, 실행이 진행 중이면 새 기록을 이어서
 * 전달합니다. 재생과 실시간 구독 사이에 누락이 생기지 않도록 먼저 listen을 등록한 뒤 현재
 * journal을 읽고, 이미 전달한 sequence는 다시 보내지 않습니다. 실행을 다시 시작하지 않습니다.
 */
export async function* followJournal(
  source: JournalSource,
  afterSequence: number,
  signal?: AbortSignal
): AsyncGenerator<GenerationJournalEntry, void, unknown> {
  let cursor = afterSequence
  let ended = false
  let wake: (() => void) | undefined
  const buffered: GenerationJournalEntry[] = []
  const notify = () => {
    const resume = wake
    wake = undefined
    resume?.()
  }
  const off = source.listen((entry) => {
    if (entry) buffered.push(entry)
    else ended = true
    notify()
  })
  const abort = () => notify()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      const state = await source.read()
      for (const entry of state.journal) {
        if (entry.sequence <= cursor) continue
        cursor = entry.sequence
        yield entry
      }
      while (buffered.length) {
        const entry = buffered.shift()
        if (!entry || entry.sequence <= cursor) continue
        cursor = entry.sequence
        yield entry
      }
      if (state.done || ended) return
      const pending = Promise.withResolvers<void>()
      wake = pending.resolve
      await pending.promise
      wake = undefined
    }
  } finally {
    off()
    signal?.removeEventListener('abort', abort)
  }
}
